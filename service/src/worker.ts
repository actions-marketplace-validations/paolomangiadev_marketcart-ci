// MarketCart CI hosted service (Cloudflare Worker + D1 + Browser Run).
//
// Public:   GET  /v1/health                     service + engine version
//           POST /v1/demo                       seeded synthetic-fixture demo (cached 10 min, free budget)
//           GET  /v1/free-token?host=           meta tag proving control of a store (free check)
//           POST /v1/free-check                 ONE free own-store case per verified store
//           POST /v1/events                     client intent events only (visit / checkout click)
// Paid:     GET  /v1/balance                    Authorization: Bearer <Payhip license key>
//           GET  /v1/domain-token?host=         Bearer -> license-bound meta tag
//           POST /v1/jobs                       Bearer -> reserve, run, consume/release (concurrency 1)
//           GET  /v1/jobs/<jobId>               Bearer -> private stored results of that license's job
// Provider: POST /v1/webhooks/payhip            signed Payhip paid/refunded events (accounting + revocation)
// Admin:    GET  /v1/stats                      Bearer ADMIN_TOKEN -> aggregates only (no identifiers)
//
// The browser runs in Cloudflare Browser Run (a supported browser runner), driven in-process through the BROWSER
// binding. There is no runner callback endpoint on the network, so none can be called unauthenticated.
// Secrets: PAYHIP_PRODUCT_SECRET_KEY, PAYHIP_API_KEY, LICENSE_PEPPER, ADMIN_TOKEN (wrangler secret put). Never logged.

import { limits } from '@cloudflare/playwright';
import { d1Db, type D1Like } from '../../api/d1.ts';
import { getGrant, getJob, releaseStale, type Db } from '../../api/ledger.ts';
import { licenseHash, payhipVerifier, type PayhipWebhook } from '../../api/payhip.ts';
import { activate, handleWebhook, runPaidJob, type ServiceConfig } from '../../api/service.ts';
import { dohResolver, findSecrets, setResolver } from '../../engine/safety.ts';
import type { CaseResult, CaseSpec, Market, Status } from '../../engine/types.ts';
import { ENGINE_VERSION } from './version.ts';
import type { BrowserRunner, RunnerItem } from './runner-do.ts';

export { BrowserRunner } from './runner-do.ts';

setResolver(dohResolver());

interface RunnerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): Pick<BrowserRunner, 'execute'>;
}

interface Env {
  BROWSER: { fetch: typeof fetch };
  RUNNER: RunnerNamespace;
  DB: D1Like;
  PAYHIP_PRODUCT_LINK: string;
  FIXTURE_HOST: string;
  FREE_DAILY_BROWSER_SECONDS: string;
  FREE_DAILY_DEMOS: string;
  FREE_DAILY_CHECKS: string;
  TEST_LICENSE_HASHES?: string;
  PAYHIP_PRODUCT_SECRET_KEY?: string;
  PAYHIP_API_KEY?: string;
  LICENSE_PEPPER?: string;
  ADMIN_TOKEN?: string;
  OPERATOR_STORES?: string; // secret: comma-separated hosts the operator owns (Founder-authorized dev store smoke)
}

const MAX_CASES_PER_JOB = 20;
const LOCK_MS = 15 * 60 * 1000;
const CLIENT_EVENTS = new Set(['qualified_visit', 'checkout_clicked']);
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|curl|wget|python|httpclient|axios|node-fetch/i;
const SHOPIFY_EGRESS = ['cdn.shopify.com', '*.shopify.com', '*.shopifycdn.com', '*.shopifycloud.com', '*.shopifysvc.com', 'shop.app', '*.shop.app'];

interface JobLine { url: string; variantId: number; quantity: number }
interface JobCase { id: string; market: Market; lines: JobLine[]; candidate?: { lines: JobLine[] }; checks?: { badge?: boolean; total?: boolean } }

// ---------- small helpers ----------
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' };
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
const romeDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const bearer = (req: Request) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readJson<T>(req: Request, limit = 64_000): Promise<T> {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text || '{}') as T;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}
class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}
const hostOk = (h: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && h.length <= 253;

// ---------- telemetry ----------
async function serverEvent(db: Db, event: string, source = 'server', dedupe?: string): Promise<void> {
  const day = romeDay();
  if (dedupe) {
    const [r] = await db.batch([{ sql: 'INSERT OR IGNORE INTO event_dedupe (key, day) VALUES (?, ?)', params: [await sha256Hex(`${day}:${event}:${dedupe}`), day] }]);
    if (r.changes === 0) return;
  }
  await db.batch([{ sql: `INSERT INTO events (day, event, source, origin, n) VALUES (?, ?, ?, 'server', 1) ON CONFLICT(day, event, source, origin) DO UPDATE SET n = n + 1`, params: [day, event, source] }]);
}

// ---------- ownership proof ----------
// The store's home page must carry <meta name="marketcart-verification" content="TOKEN">. For password-protected
// stores the storefront password is used once, in memory, to read the real home page.
async function ownershipVerified(host: string, token: string, password?: string): Promise<{ ok: boolean; why: string }> {
  const ua = { 'user-agent': 'MarketCartCI-verify/0.2 (+https://marketcart-ci.pages.dev)' };
  // Shopify keeps the unlocked state in its session cookies and requires the form's authenticity_token (CSRF),
  // so the gate is passed like a browser would: GET the form, POST with its token and cookies, then GET /.
  const jar = new Map<string, string>();
  const eat = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let r = await fetch(`https://${host}/`, { redirect: 'manual', headers: ua });
  eat(r);
  const loc = r.headers.get('location') ?? '';
  if (r.status >= 300 && r.status < 400 && /\/password(\?|$)/.test(loc)) {
    if (!password) return { ok: false, why: 'store is password-protected: include its storefrontPassword' };
    const g = await fetch(`https://${host}/password`, { redirect: 'manual', headers: { ...ua, cookie: cookie() } });
    eat(g);
    const form = await g.text();
    const token = form.match(/name="authenticity_token"[^>]*value="([^"]+)"/)?.[1] ?? form.match(/value="([^"]+)"[^>]*name="authenticity_token"/)?.[1] ?? '';
    const body = new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', authenticity_token: token, password });
    const p = await fetch(`https://${host}/password`, { method: 'POST', redirect: 'manual', headers: { ...ua, 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() }, body });
    eat(p);
    if (p.status === 429) return { ok: false, why: 'store rate-limited the password form (HTTP 429); retry later' };
    r = await fetch(`https://${host}/`, { redirect: 'manual', headers: { ...ua, cookie: cookie() } });
    if (r.status >= 300 && r.status < 400 && /\/password/.test(r.headers.get('location') ?? '')) return { ok: false, why: 'storefront password rejected' };
  }
  if (r.status !== 200) return { ok: false, why: `home page HTTP ${r.status}` };
  const html = (await r.text()).slice(0, 300_000);
  // A store may carry several tags (e.g. the free-check tag and a license tag); any exact match proves control.
  const tags = [...html.matchAll(/<meta[^>]+name=["']marketcart-verification["'][^>]+content=["']([a-f0-9]{24})["']/gi)].map((m) => m[1]);
  if (tags.length === 0) return { ok: false, why: 'verification meta tag not found on the home page' };
  return tags.includes(token) ? { ok: true, why: 'verified' } : { ok: false, why: 'verification token does not match' };
}
const licenseDomainToken = (pepper: string, licHash: string, host: string) => hmacHex(pepper, `domain:${licHash}:${host}`).then((h) => h.slice(0, 24));
const freeDomainToken = (pepper: string, host: string) => hmacHex(pepper, `free:${host}`).then((h) => h.slice(0, 24));

// ---------- runner (Browser Run) ----------
async function acquireLock(db: Db, holder: string): Promise<boolean> {
  const now = Date.now();
  const [r] = await db.batch([{ sql: 'UPDATE runner_lock SET holder = ?, expires_at = ? WHERE id = 1 AND expires_at < ?', params: [holder, now + LOCK_MS, now] }]);
  return r.changes === 1;
}
async function releaseLock(db: Db, holder: string): Promise<void> {
  await db.batch([{ sql: 'UPDATE runner_lock SET holder = NULL, expires_at = 0 WHERE id = 1 AND holder = ?', params: [holder] }]);
}
async function usedBrowserSeconds(env: Env): Promise<number | null> {
  try {
    const l = (await limits(env.BROWSER)) as unknown as { usedBrowserTimeSeconds?: number };
    return typeof l.usedBrowserTimeSeconds === 'number' ? l.usedBrowserTimeSeconds : null;
  } catch {
    return null;
  }
}

// sessionMs = our own launch->close measurement of the Browser Run session (an upper bound of billed browser time;
// Browser Run's usedBrowserTimeSeconds counter lags and is reconciled separately via /v1/stats).
interface RunStats { wallMs: number; sessionMs: number; launchRetries: number }
async function runOnRunner(env: Env, allowed: string[], items: RunnerItem[], passwords: Record<string, string> = {}, pauseMs = 0): Promise<{ value: CaseResult[]; stats: RunStats }> {
  const stub = env.RUNNER.get(env.RUNNER.idFromName('browser-runner'));
  try {
    const r = await stub.execute({ allowed, items, passwords, pauseMs, engineVersion: ENGINE_VERSION });
    return { value: r.results, stats: r.stats };
  } catch (e) {
    throw new HttpError(503, `browser runner unavailable: ${String((e as Error).message ?? e).slice(0, 160)}`);
  }
}
async function recordUsage(_env: Env, db: Db, runId: string, kind: string, started: number, results: CaseResult[], launchRetries: number, sessionMs: number): Promise<RunStats> {
  const browserMs = sessionMs;
  const wallMs = Date.now() - started;
  const completed = results.filter((r) => r.status === 'PASS' || r.status === 'REGRESSION').length;
  await db.batch([{
    sql: 'INSERT OR REPLACE INTO runner_usage (run_id, kind, started_at, wall_ms, browser_ms, cases, completed, inconclusive, attempts, launch_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [runId, kind, started, wallMs, browserMs, results.length, completed, results.length - completed, results.reduce((n, r) => n + r.attempts, 0), launchRetries],
  }]);
  return { wallMs, sessionMs, launchRetries };
}

function specFrom(c: JobCase, domains: string[], evidence: CaseSpec['evidenceClass']): { single?: CaseSpec; pair?: { id: string; live: CaseSpec; candidate: CaseSpec } } {
  const base: CaseSpec = { id: c.id, adapter: 'dawn', market: c.market, lines: c.lines, authorizedDomains: domains, evidenceClass: evidence, checks: c.checks };
  if (c.candidate) return { pair: { id: c.id, live: { ...base, id: `${c.id}-live` }, candidate: { ...base, id: `${c.id}-candidate`, lines: c.candidate.lines } } };
  return { single: base };
}
function validateCases(cases: unknown): JobCase[] {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > MAX_CASES_PER_JOB) throw new HttpError(400, `1..${MAX_CASES_PER_JOB} cases per job`);
  const lineOk = (l: JobLine) => typeof l?.url === 'string' && l.url.length < 2048 && Number.isSafeInteger(l.variantId) && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 10;
  for (const c of cases as JobCase[]) {
    if (typeof c?.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(c.id)) throw new HttpError(400, 'case id must match [A-Za-z0-9._-]{1,64}');
    if (!/^[A-Z]{2}$/.test(c.market?.country ?? '') || !/^[A-Z]{3}$/.test(c.market?.currency ?? '')) throw new HttpError(400, `case ${c.id}: market needs ISO country + currency`);
    if (!Array.isArray(c.lines) || c.lines.length === 0 || c.lines.length > 5 || !c.lines.every(lineOk)) throw new HttpError(400, `case ${c.id}: 1..5 lines with url, variantId, quantity 1..10`);
    if (c.candidate && (!Array.isArray(c.candidate.lines) || !c.candidate.lines.every(lineOk))) throw new HttpError(400, `case ${c.id}: invalid candidate lines`);
  }
  return cases as JobCase[];
}
// Public result shape: no storefront passwords (never inside results), no screenshots, nothing about other licenses.
function publicResult(r: CaseResult) {
  return { caseId: r.caseId, kind: r.kind, status: r.status, reason: r.reason, checks: r.checks, market: r.market, stored: r.stored, visible: r.visible, durationMs: r.durationMs, attempts: r.attempts, casesConsumed: r.casesConsumed, engineVersion: r.engineVersion, evidenceClass: r.source.evidenceClass, urls: r.source.urls, parts: r.parts?.map((p) => ({ caseId: p.caseId, status: p.status, reason: p.reason })) };
}

// ---------- free budget ----------
async function freeBudget(env: Env, db: Db, kind: 'demo' | 'free'): Promise<{ ok: boolean; why?: string }> {
  const day = romeDay();
  await db.batch([{ sql: 'INSERT OR IGNORE INTO free_usage (day) VALUES (?)', params: [day] }]);
  const u = (await db.get<{ demo_runs: number; free_checks: number; browser_ms: number }>('SELECT * FROM free_usage WHERE day = ?', [day]))!;
  if (u.browser_ms >= Number(env.FREE_DAILY_BROWSER_SECONDS) * 1000) return { ok: false, why: 'daily free execution budget used up; fixture results below are the last cached run' };
  if (kind === 'demo' && u.demo_runs >= Number(env.FREE_DAILY_DEMOS)) return { ok: false, why: 'daily demo budget used up' };
  if (kind === 'free' && u.free_checks >= Number(env.FREE_DAILY_CHECKS)) return { ok: false, why: 'daily free own-store checks used up; try tomorrow' };
  return { ok: true };
}
async function chargeFree(db: Db, kind: 'demo' | 'free', sessionMs: number, wallMs: number): Promise<void> {
  const ms = Math.max(sessionMs, 0) || wallMs; // conservative: our measured session time, else request wall time
  await db.batch([{ sql: `UPDATE free_usage SET ${kind === 'demo' ? 'demo_runs = demo_runs + 1' : 'free_checks = free_checks + 1'}, browser_ms = browser_ms + ? WHERE day = ?`, params: [ms, romeDay()] }]);
}

// ---------- handlers ----------
async function demo(env: Env, db: Db): Promise<Response> {
  const cached = await db.get<{ ran_at: number; result_json: string }>('SELECT * FROM demo_cache WHERE id = 1', []);
  if (cached && Date.now() - cached.ran_at < 10 * 60 * 1000) return json(200, { cached: true, ranAt: new Date(cached.ran_at).toISOString(), ...JSON.parse(cached.result_json) });
  const budget = await freeBudget(env, db, 'demo');
  const holder = `demo-${crypto.randomUUID()}`;
  if (!budget.ok || !(await acquireLock(db, holder))) {
    if (cached) return json(200, { cached: true, ranAt: new Date(cached.ran_at).toISOString(), note: budget.why ?? 'runner busy', ...JSON.parse(cached.result_json) });
    return json(429, { error: budget.why ?? 'runner busy, retry in a minute' });
  }
  const started = Date.now();
  try {
    const fx = env.FIXTURE_HOST;
    const u = (sc: string, preview = false) => `https://${fx}/s/${sc}/products/linen-shirt?variant=4101&country=IE${preview ? '&preview_theme_id=fixture-candidate' : ''}`;
    const mk = (id: string, sc: string, preview = false): CaseSpec => ({ id, adapter: 'dawn', market: { country: 'IE', currency: 'EUR' }, authorizedDomains: [fx], evidenceClass: 'synthetic-fixture', lines: [{ url: u(sc, preview), variantId: 4101, quantity: 1 }] });
    const { value: results, stats } = await runOnRunner(env, [fx], [
      { single: mk('C01', 'healthy') },
      { single: mk('C05', 'stale-drawer') },
      { pair: { id: 'C16', live: mk('C16-live', 'healthy'), candidate: mk('C16-candidate', 'stale-drawer', true) } },
    ]);
    const expected: Record<string, Status> = { C01: 'PASS', C05: 'REGRESSION', C16: 'REGRESSION' };
    const usage = await recordUsage(env, db, holder, 'demo', started, results, stats.launchRetries, stats.sessionMs);
    await chargeFree(db, 'demo', usage.sessionMs, usage.wallMs);
    const payload = { evidenceClass: 'synthetic-fixture', engineVersion: ENGINE_VERSION, results: results.map((r) => ({ ...publicResult(r), expected: expected[r.caseId] })), usage };
    await db.batch([{ sql: 'INSERT OR REPLACE INTO demo_cache (id, ran_at, result_json) VALUES (1, ?, ?)', params: [Date.now(), JSON.stringify(payload)] }]);
    await serverEvent(db, 'demo_completed', 'checker');
    return json(200, { cached: false, ranAt: new Date().toISOString(), ...payload });
  } finally {
    await releaseLock(db, holder);
  }
}

async function freeCheck(req: Request, env: Env, db: Db): Promise<Response> {
  if (!env.LICENSE_PEPPER) return json(503, { error: 'service not configured' });
  const b = await readJson<{ url?: string; variantId?: number; quantity?: number; market?: Market; storefrontPassword?: string; source?: string }>(req);
  let url: URL;
  try {
    url = new URL(String(b.url ?? ''));
  } catch {
    return json(400, { error: 'url must be a product URL on your store' });
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !hostOk(host)) return json(400, { error: 'https product URL required' });
  const [c] = validateCases([{ id: 'free-check', market: b.market, lines: [{ url: url.toString(), variantId: Number(b.variantId), quantity: Number(b.quantity ?? 1) }] }]);
  const own = await ownershipVerified(host, await freeDomainToken(env.LICENSE_PEPPER, host), b.storefrontPassword);
  if (!own.ok) return json(403, { error: `ownership not verified: ${own.why}`, hint: `GET /v1/free-token?host=${host} and add the meta tag to your theme <head>` });
  const hostHash = await hmacHex(env.LICENSE_PEPPER, `host:${host}`);
  const [claim] = await db.batch([{ sql: 'INSERT OR IGNORE INTO free_checks (host_hash, created_at) VALUES (?, ?)', params: [hostHash, Date.now()] }]);
  if (claim.changes === 0) return json(409, { error: 'this store already used its free check; buy a pack for more' });
  const budget = await freeBudget(env, db, 'free');
  const holder = `free-${crypto.randomUUID()}`;
  if (!budget.ok || !(await acquireLock(db, holder))) {
    await db.batch([{ sql: 'DELETE FROM free_checks WHERE host_hash = ? AND status IS NULL', params: [hostHash] }]);
    return json(429, { error: budget.why ?? 'runner busy, retry in a minute' });
  }
  const started = Date.now();
  try {
    const { value: rs, stats } = await runOnRunner(env, [host, ...SHOPIFY_EGRESS], [{ single: specFrom(c, [host], 'live-shopify').single! }], b.storefrontPassword ? { [host]: b.storefrontPassword } : {});
    const r = rs[0];
    const usage = await recordUsage(env, db, holder, 'free', started, [r], stats.launchRetries, stats.sessionMs);
    await chargeFree(db, 'free', usage.sessionMs, usage.wallMs);
    const completed = r.status === 'PASS' || r.status === 'REGRESSION';
    if (completed) {
      await db.batch([{ sql: 'UPDATE free_checks SET status = ?, result_json = ? WHERE host_hash = ?', params: [r.status, JSON.stringify({ status: r.status, reason: r.reason }), hostHash] }]);
      await serverEvent(db, 'own_store_completed', (b.source ?? 'direct').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'direct', hostHash);
    } else {
      await db.batch([{ sql: 'DELETE FROM free_checks WHERE host_hash = ?', params: [hostHash] }]); // inconclusive: free check not used up
    }
    return json(200, { freeCheckUsed: completed, result: publicResult(r), usage });
  } finally {
    await releaseLock(db, holder);
  }
}

function serviceConfig(env: Env, db: Db): ServiceConfig {
  if (!env.PAYHIP_PRODUCT_SECRET_KEY || !env.LICENSE_PEPPER || !env.PAYHIP_PRODUCT_LINK) throw new HttpError(503, 'paid service not configured yet');
  return {
    db,
    verifier: payhipVerifier(env.PAYHIP_PRODUCT_SECRET_KEY), // production verifier only; no mock path exists in this Worker
    productLink: env.PAYHIP_PRODUCT_LINK,
    pepper: env.LICENSE_PEPPER,
    payhipApiKey: env.PAYHIP_API_KEY ?? '',
    testLicenseHashes: new Set((env.TEST_LICENSE_HASHES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  };
}

async function paidJob(req: Request, env: Env, db: Db, key: string): Promise<Response> {
  const cfg = serviceConfig(env, db);
  const b = await readJson<{ jobId?: string; authorizedDomains?: string[]; cases?: unknown; storefrontPasswords?: Record<string, string>; source?: string }>(req);
  const cases = validateCases(b.cases);
  const domains = [...new Set((b.authorizedDomains ?? []).map((d) => String(d).toLowerCase()))].filter(hostOk);
  if (domains.length === 0 || domains.length > 3) return json(400, { error: 'authorizedDomains: 1..3 store hosts' });
  for (const c of cases) for (const l of [...c.lines, ...(c.candidate?.lines ?? [])]) {
    const h = new URL(l.url).hostname.toLowerCase();
    if (!domains.includes(h)) return json(400, { error: `case ${c.id}: ${h} is not in authorizedDomains` });
  }
  const jobId = String(b.jobId ?? crypto.randomUUID()).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80);
  const units = cases.reduce((n, c) => n + (c.candidate ? 2 : 1), 0);
  const lh = licenseHash(cfg.pepper, key);
  const existing = await getJob(db, jobId);
  if (existing && existing.license_hash !== lh) return json(409, { error: 'jobId already used' });
  if (!existing) {
    const a = await activate(cfg, key);
    if (!a.ok) return json(a.error === 'verifier_unavailable' ? 503 : 403, a);
    const passwords = b.storefrontPasswords ?? {};
    for (const d of domains) {
      const own = await ownershipVerified(d, await licenseDomainToken(cfg.pepper, lh, d), passwords[d]);
      if (!own.ok) return json(403, { error: `domain ${d} not verified: ${own.why}`, hint: 'GET /v1/domain-token?host=<host> and add the meta tag to your theme <head>' });
    }
  }
  const holder = `paid-${jobId}`;
  if (!existing && !(await acquireLock(db, holder))) return json(429, { error: 'runner busy (concurrency 1), retry in a minute', retryAfterSeconds: 60 });
  const started = Date.now();
  let launchRetries = 0;
  let sessionMs = 0;
  try {
    const items: RunnerItem[] = cases.map((c) => {
      const one = specFrom(c, domains, 'live-shopify');
      return one.pair ? { pair: one.pair } : { single: one.single! };
    });
    const exec = async () => {
      const { value, stats } = await runOnRunner(env, [...domains, ...SHOPIFY_EGRESS], items, b.storefrontPasswords ?? {}, 2_000);
      launchRetries = stats.launchRetries;
      sessionMs = stats.sessionMs;
      return value;
    };
    const r = await runPaidJob(cfg, key, jobId, units, exec);
    if (!r.ok) return json(r.error === 'insufficient_credits' ? 402 : r.error === 'verifier_unavailable' ? 503 : 403, r);
    if (r.replay) return json(200, { jobId, replay: true, consumed: r.consumed, released: r.released, results: r.results });
    const usage = await recordUsage(env, db, holder, 'paid', started, r.results, launchRetries, sessionMs);
    const g = await getGrant(db, lh);
    if (g && g.is_test === 0 && r.consumed > 0) {
      for (const res of r.results) if (res.status === 'PASS' || res.status === 'REGRESSION') await serverEvent(db, 'paid_case_completed', 'api');
      const days = await db.all<{ d: string }>(`SELECT DISTINCT date(completed_at / 1000, 'unixepoch') AS d FROM jobs WHERE license_hash = ? AND state = 'completed' AND consumed > 0`, [lh]);
      if (days.length >= 2) await serverEvent(db, 'repeat_paid_use', 'api', lh);
    }
    const body = { jobId, replay: false, engineVersion: ENGINE_VERSION, consumed: r.consumed, released: r.released, available: g?.available ?? null, test: g?.is_test === 1, results: r.results.map(publicResult), usage };
    if (findSecrets(JSON.stringify(body)).length) return json(500, { error: 'result withheld: secret pattern detected' });
    return json(200, body);
  } finally {
    if (!existing) await releaseLock(db, holder);
  }
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const db = d1Db(env.DB);
  const p = url.pathname;
  // Public traffic arrives through the Pages front (marketcart-ci.pages.dev) via a service binding. The account's
  // *.workers.dev address only keeps the Payhip webhook path alive until the webhook URL is moved; nothing else.
  if (url.hostname.endsWith('.workers.dev') && !(req.method === 'POST' && p === '/v1/webhooks/payhip')) return json(404, { error: 'not found' });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (p === '/v1/health') return json(200, { ok: true, engineVersion: ENGINE_VERSION, runner: 'cloudflare-browser-run', paidConfigured: !!(env.PAYHIP_PRODUCT_SECRET_KEY && env.LICENSE_PEPPER && env.PAYHIP_PRODUCT_LINK), webhookConfigured: !!env.PAYHIP_API_KEY });
  if (p === '/v1/demo' && req.method === 'POST') return demo(env, db);
  if (p === '/v1/free-token' && req.method === 'GET') {
    if (!env.LICENSE_PEPPER) return json(503, { error: 'service not configured' });
    const host = (url.searchParams.get('host') ?? '').toLowerCase();
    if (!hostOk(host)) return json(400, { error: 'host required, e.g. your-store.myshopify.com' });
    return json(200, { host, meta: `<meta name="marketcart-verification" content="${await freeDomainToken(env.LICENSE_PEPPER, host)}">`, where: 'Online Store > Themes > Edit code > layout/theme.liquid, inside <head>' });
  }
  if (p === '/v1/free-check' && req.method === 'POST') return freeCheck(req, env, db);
  if (p === '/v1/events' && req.method === 'POST') {
    const b = await readJson<{ event?: string; source?: string; vid?: string }>(req, 2_000);
    if (!b.event || !CLIENT_EVENTS.has(b.event)) return json(403, { error: 'only qualified_visit and checkout_clicked are client-reported; other events are derived server-side' });
    const ua = req.headers.get('user-agent') ?? '';
    if (BOT_UA.test(ua) || req.headers.get('x-marketcart-self') === '1' || !/^[a-f0-9]{16,32}$/.test(b.vid ?? '')) return json(202, { counted: false });
    const source = String(b.source ?? 'direct').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'direct';
    const day = romeDay();
    const [d] = await db.batch([{ sql: 'INSERT OR IGNORE INTO event_dedupe (key, day) VALUES (?, ?)', params: [await sha256Hex(`${day}:${env.LICENSE_PEPPER ?? ''}:${b.vid}:${b.event}:${source}`), day] }]);
    if (d.changes === 1) await db.batch([{ sql: `INSERT INTO events (day, event, source, origin, n) VALUES (?, ?, ?, 'client', 1) ON CONFLICT(day, event, source, origin) DO UPDATE SET n = n + 1`, params: [day, b.event, source] }]);
    return json(202, { counted: d.changes === 1 });
  }
  if (p === '/v1/webhooks/payhip' && req.method === 'POST') {
    if (!env.PAYHIP_API_KEY || !env.LICENSE_PEPPER) return json(503, { error: 'webhook not configured' }); // Payhip retries hourly for 3 h
    const payload = await readJson<PayhipWebhook>(req, 128_000);
    const cfg = { ...serviceConfig(env, db), payhipApiKey: env.PAYHIP_API_KEY };
    const r = await handleWebhook(cfg, payload);
    if (r.note === 'sale recorded') {
      const gross = Number(payload.price ?? 0);
      if (gross === 0) await db.batch([{ sql: 'UPDATE sales SET is_test = 1 WHERE transaction_id = ?', params: [payload.id] }]); // 100% coupon = TEST
      else await serverEvent(db, 'verified_purchase', 'payhip', payload.id);
    }
    if (r.note === 'refund recorded') await serverEvent(db, 'refund', 'payhip', payload.id);
    return json(r.status, { note: r.note });
  }
  if (p === '/v1/stats' && req.method === 'GET') {
    if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) return json(401, { error: 'admin only' });
    const since = url.searchParams.get('since') ?? '2026-11-06';
    return json(200, {
      events: await db.all('SELECT day, event, source, origin, n FROM events WHERE day >= ? ORDER BY day, event', [since]),
      runnerUsage: await db.all('SELECT kind, COUNT(*) AS runs, SUM(cases) AS cases, SUM(completed) AS completed, SUM(inconclusive) AS inconclusive, SUM(attempts) AS attempts, SUM(wall_ms) AS wall_ms, SUM(browser_ms) AS browser_ms, SUM(launch_retries) AS launch_retries FROM runner_usage GROUP BY kind', []),
      freeUsage: await db.all('SELECT * FROM free_usage WHERE day >= ? ORDER BY day', [since]),
      grants: await db.all('SELECT is_test, COUNT(*) AS n, SUM(available) AS available, SUM(reserved) AS reserved, SUM(consumed) AS consumed, SUM(revoked_at IS NOT NULL) AS revoked FROM grants GROUP BY is_test', []),
      sales: await db.all('SELECT is_test, currency, COUNT(*) AS n, SUM(gross_minor) AS gross_minor, SUM(refunded_minor) AS refunded_minor FROM sales GROUP BY is_test, currency', []),
      openJobs: await db.all(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'reserved'`, []),
      browserRunUsedSecondsToday: await usedBrowserSeconds(env), // Cloudflare's own counter (lags; reconcile)
    });
  }
  // Operator revocation test: disables a TEST license at Payhip (v2 license/disable). Refuses any non-test key.
  if (p === '/v1/admin/license-disable' && req.method === 'POST') {
    if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) return json(401, { error: 'admin only' });
    const cfg = serviceConfig(env, db);
    const b = await readJson<{ license_key?: string }>(req, 2_000);
    const lk = String(b.license_key ?? '').trim().toUpperCase();
    if (!cfg.testLicenseHashes?.has(licenseHash(cfg.pepper, lk))) return json(403, { error: 'only TEST licenses can be disabled here' });
    const r = await fetch('https://payhip.com/api/v2/license/disable', { method: 'PUT', headers: { 'product-secret-key': env.PAYHIP_PRODUCT_SECRET_KEY!, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ license_key: lk }) });
    const text = await r.text();
    let enabled: unknown = null;
    try {
      enabled = (JSON.parse(text) as { data?: { enabled?: boolean } }).data?.enabled ?? null;
    } catch {}
    return json(r.ok ? 200 : 502, { payhipStatus: r.status, enabled });
  }
  // Operator smoke on the Founder-authorized dev store(s): same engine, same production runner, no credits involved.
  if (p === '/v1/admin/smoke' && req.method === 'POST') {
    if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) return json(401, { error: 'admin only' });
    const stores = (env.OPERATOR_STORES ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const b = await readJson<{ runId?: string; cases?: unknown; storefrontPassword?: string; pauseMs?: number }>(req);
    const cases = validateCases(b.cases);
    const hosts = [...new Set(cases.flatMap((c) => [...c.lines, ...(c.candidate?.lines ?? [])].map((l) => new URL(l.url).hostname.toLowerCase())))];
    if (!hosts.every((h) => stores.includes(h))) return json(403, { error: 'operator smoke is limited to OPERATOR_STORES' });
    const holder = `smoke-${String(b.runId ?? crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60)}`;
    if (!(await acquireLock(db, holder))) return json(429, { error: 'runner busy' });
    const started = Date.now();
    try {
      const pw = b.storefrontPassword;
      const items: RunnerItem[] = cases.map((c) => {
        const one = specFrom(c, hosts, 'live-shopify');
        return one.pair ? { pair: one.pair } : { single: one.single! };
      });
      const { value: results, stats } = await runOnRunner(env, [...hosts, ...SHOPIFY_EGRESS], items, pw ? Object.fromEntries(hosts.map((h) => [h, pw])) : {}, Number(b.pauseMs ?? 3000));
      const usage = await recordUsage(env, db, holder, 'smoke', started, results, stats.launchRetries, stats.sessionMs);
      return json(200, { runId: holder, engineVersion: ENGINE_VERSION, runner: 'cloudflare-browser-run', usage, results: results.map(publicResult) });
    } finally {
      await releaseLock(db, holder);
    }
  }
  // Paid endpoints (license key in the Authorization header only, never in URLs).
  if (p === '/v1/balance' || p === '/v1/domain-token' || p === '/v1/jobs' || p.startsWith('/v1/jobs/')) {
    const key = bearer(req);
    if (!key) return json(401, { error: 'missing license key (Authorization: Bearer ...)' });
    const cfg = serviceConfig(env, db);
    if (p === '/v1/balance' && req.method === 'GET') {
      const a = await activate(cfg, key);
      return json(a.ok ? 200 : a.error === 'verifier_unavailable' ? 503 : 403, a);
    }
    if (p === '/v1/domain-token' && req.method === 'GET') {
      const host = (url.searchParams.get('host') ?? '').toLowerCase();
      if (!hostOk(host)) return json(400, { error: 'host required' });
      const a = await activate(cfg, key);
      if (!a.ok) return json(403, a);
      const token = await licenseDomainToken(cfg.pepper, licenseHash(cfg.pepper, key), host);
      return json(200, { host, meta: `<meta name="marketcart-verification" content="${token}">`, where: 'Online Store > Themes > Edit code > layout/theme.liquid, inside <head>' });
    }
    if (p === '/v1/jobs' && req.method === 'POST') return paidJob(req, env, db, key);
    if (p.startsWith('/v1/jobs/') && req.method === 'GET') {
      const job = await getJob(db, decodeURIComponent(p.slice('/v1/jobs/'.length)));
      if (!job || job.license_hash !== licenseHash(cfg.pepper, key)) return json(404, { error: 'job not found' });
      return json(200, { jobId: job.job_id, state: job.state, reserved: job.cases_reserved, consumed: job.consumed, released: job.released, completedAt: job.completed_at, results: job.result_json ? JSON.parse(job.result_json) : null });
    }
  }
  return json(404, { error: 'not found' });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      return json(500, { error: 'internal error' });
    }
  },
  async scheduled(_c: unknown, env: Env): Promise<void> {
    const db = d1Db(env.DB);
    await releaseStale(db, LOCK_MS + 60_000, Date.now()); // lost runs release their reserved credits
    await db.batch([{ sql: 'DELETE FROM event_dedupe WHERE day < ?', params: [romeDay(Date.now() - 2 * 86400_000)] }]);
  },
};
