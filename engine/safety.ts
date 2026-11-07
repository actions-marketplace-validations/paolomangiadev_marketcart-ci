// Execution safety: authorized domains only, SSRF protection (DNS + every request/redirect), no checkout/payment/account paths.

// Runtime-neutral: no static node: imports, so the same module runs in Node and in a Cloudflare Worker.
// DNS resolution is injectable (Node: dns.lookup; Worker: DNS-over-HTTPS) and fails closed.

export type Resolver = (host: string) => Promise<string[]>;

export const nodeResolver: Resolver = async (host) => {
  const dns = await import('node:dns/promises');
  const addrs = await dns.lookup(host, { all: true, verbatim: true });
  return addrs.map((a) => a.address);
};

// DNS-over-HTTPS (JSON API). Used by the Worker runtime, where node:dns is not available.
export function dohResolver(endpoint = 'https://cloudflare-dns.com/dns-query', fetchImpl: typeof fetch = fetch): Resolver {
  return async (host) => {
    const out: string[] = [];
    for (const type of ['A', 'AAAA']) {
      const r = await fetchImpl(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
      if (!r.ok) throw new Error(`DoH HTTP ${r.status}`);
      const j = (await r.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
      for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
    }
    return out;
  };
}

let resolver: Resolver = nodeResolver;
export function setResolver(r: Resolver): void {
  resolver = r;
  dnsCache.clear();
}

// IP family without node:net. 4, 6 or 0 (not an IP literal).
export function ipFamily(s: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s)) return 4;
  if (s.includes(':') && /^[0-9a-f:.]+$/i.test(s) && (s.match(/::/g) ?? []).length <= 1) return 6;
  return 0;
}

export interface SafetyPolicy {
  authorizedDomains: string[]; // exact host or parent domain the owner verified
  allowLoopbackFixture: boolean; // true only for the local synthetic benchmark
}

export class SafetyError extends Error {}

const BLOCKED_PATHS = [/^\/checkouts?(\/|$)/i, /^\/cart\/checkout/i, /\/checkouts?\//i, /^\/account(\/|$)/i, /^\/payments?(\/|$)/i, /^\/admin(\/|$)/i, /^\/password(\/|$)/i];

export function isBlockedPath(pathname: string): boolean {
  return BLOCKED_PATHS.some((re) => re.test(pathname));
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_PRIVATE: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  const fam = ipFamily(ip);
  if (fam === 4) {
    const n = ipv4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (fam === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
  }
  return true; // not an IP -> treat as unsafe
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export function hostAuthorized(host: string, policy: SafetyPolicy): boolean {
  const h = host.toLowerCase();
  return policy.authorizedDomains.some((d) => {
    const dom = d.toLowerCase();
    return h === dom || h.endsWith('.' + dom);
  });
}

const dnsCache = new Map<string, Promise<boolean>>();

async function resolvesPublic(host: string): Promise<boolean> {
  if (ipFamily(host)) return !isPrivateAddress(host);
  let p = dnsCache.get(host);
  if (!p) {
    p = resolver(host)
      .then((addrs) => addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a)))
      .catch(() => false);
    dnsCache.set(host, p);
  }
  return p;
}

// Validate a case URL before any browser work.
export async function assertCaseUrl(raw: string, policy: SafetyPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafetyError(`invalid URL`);
  }
  if (url.username || url.password) throw new SafetyError('credentials in URL are not allowed');
  const loopback = isLoopbackHost(url.hostname);
  if (loopback) {
    if (!policy.allowLoopbackFixture) throw new SafetyError('loopback targets are not allowed');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafetyError('unsupported scheme');
  } else {
    if (url.protocol !== 'https:') throw new SafetyError('only https storefronts are allowed');
    if (!hostAuthorized(url.hostname, policy)) throw new SafetyError(`host ${url.hostname} is not an owner-authorized domain`);
    if (!(await resolvesPublic(url.hostname))) throw new SafetyError(`host ${url.hostname} resolves to a private/unresolvable address`);
  }
  if (isBlockedPath(url.pathname)) throw new SafetyError('checkout/account/payment paths are never visited');
  return url;
}

// Per-request decision inside the browser (covers redirects and every sub-resource).
// Navigations (documents) must stay on authorized hosts; sub-resources may load from public hosts (CDNs) but never private ranges.
export async function allowRequest(raw: string, isNavigation: boolean, policy: SafetyPolicy): Promise<{ ok: boolean; why?: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: 'invalid url' };
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return { ok: true };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, why: `scheme ${url.protocol}` };
  if (isBlockedPath(url.pathname) && hostAuthorized(url.hostname, policy)) return { ok: false, why: 'blocked path' };
  if (isBlockedPath(url.pathname) && isLoopbackHost(url.hostname)) return { ok: false, why: 'blocked path' };
  if (isLoopbackHost(url.hostname)) return policy.allowLoopbackFixture ? { ok: true } : { ok: false, why: 'loopback' };
  if (isNavigation && !hostAuthorized(url.hostname, policy)) return { ok: false, why: `navigation to unauthorized host ${url.hostname}` };
  if (url.protocol !== 'https:') return { ok: false, why: 'plain http sub-resource' };
  if (!(await resolvesPublic(url.hostname))) return { ok: false, why: 'private address' };
  return { ok: true };
}

// Strip everything from a URL except the parameters needed to reproduce a case.
const KEEP_PARAMS = new Set(['variant', 'country', 'preview_theme_id']);
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (!KEEP_PARAMS.has(k)) u.searchParams.delete(k);
    if (isLoopbackHost(u.hostname)) u.host = 'fixture.local';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}

// Patterns that must never appear in emitted output.
export const SECRET_PATTERNS: RegExp[] = [
  /shpat_[a-f0-9]{16,}/i, /shpss_[a-f0-9]{16,}/i, /apify_api_[A-Za-z0-9]{20,}/, /fc-[a-f0-9]{24,}/i, /sk_(live|test)_[A-Za-z0-9]{16,}/,
  /product-secret-key/i, /\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/, /Bearer\s+[A-Za-z0-9._-]{20,}/, /PAYHIP_[A-Z_]*=\S+/,
];

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}
