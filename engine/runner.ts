// Browser runner: one isolated context per case, concurrency 1, bounded timeout, at most one retry per case
// (retryable ERROR, or HTTP 429 after the store's pacing delay), always in a fresh isolated context.
// Runtime-neutral: takes a Playwright-compatible Browser (playwright-core locally, @cloudflare/playwright in the
// hosted runner). Only type imports from playwright-core, so nothing here loads a browser runtime.

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { classify, comparePair, totalMode, verifyMarket } from './assert.ts';
import { readPageContext, readStoredCart } from './adapters/dawn.ts';
import { ADAPTERS, adapterForSchema, drawerIsOpen, readVisibleCartAny, type AdapterName } from './adapters/themes.ts';
import { parseRetryAfter, type StorePacer } from './pacing.ts';
import { shopifyCentsToIsoMinor } from './money.ts';
import { allowRequest, assertCaseUrl, hostAuthorized, sanitizeUrl, SafetyError, type SafetyPolicy } from './safety.ts';
import type { CaseResult, CaseSpec, Check, MarketObservation, PairSpec, Status, StoredCart, VisibleCart } from './types.ts';

export const MAX_TIMEOUT_MS = 90_000;

// Fault injection for OUR live smoke only (never reachable from the API/CLI): mutates the add-to-cart response inside
// the isolated browser session, so a healthy store can prove mismatch detection without editing the merchant theme.
//   stale-drawer: drop the re-rendered sections from /cart/add.js, so Dawn cannot refresh the drawer or badge.
//   swap-variant: rewrite the submitted variant id (a variant-picker bug): the store persists a variant nobody asked for.
export type FaultInjection = { kind: 'stale-drawer' } | { kind: 'swap-variant'; from: number; to: number };

export interface GateCookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }

export interface RunOptions {
  engineVersion: string;
  allowLoopbackFixture: boolean;
  screenshotDir: string | null;
  headless?: boolean;
  storefrontPasswords?: Record<string, string>; // host -> storefront password; never logged, stored or returned
  // Per-job memory of the storefront-password digest cookie, so a job unlocks a store once instead of POSTing the
  // password for every case (Shopify rate-limits that with HTTP 429). Only the digest cookie is carried: the cart
  // cookie never crosses cases, so every case still starts from an empty, isolated cart. Never persisted.
  gateCookies?: Map<string, GateCookie[]>;
  inject?: FaultInjection;
  // Per-store pacing (shared across jobs by the caller). Without a pacer, no waits are inserted.
  pacer?: StorePacer;
  deadlineAt?: number; // overall job deadline (epoch ms): a case that cannot START before it is BLOCKED, not hung
  // 'inline' (default): runCase waits for the pacer and retries itself. 'none': caller owns pacing/retry, e.g. the
  // hosted runner, which waits OUTSIDE the browser session and relaunches for the retry.
  retry?: 'inline' | 'none';
}

interface Attempt {
  status: Status;
  reason: string;
  checks: Check[];
  market: MarketObservation | null;
  stored: StoredCart | null;
  visible: VisibleCart | null;
  screenshot: string | null;
  retryable: boolean;
  rateLimited: boolean;
  retryAfterMs: number | null;
  theme: { schema: string | null; version: string | null; adapter: AdapterName | null; surface: 'drawer' | 'cart-page' | null };
}

class Stop extends Error {
  status: Status;
  retryable: boolean;
  rateLimited: boolean;
  retryAfterMs: number | null;
  constructor(status: Status, reason: string, retryable = false, rate?: { retryAfterMs: number | null }) {
    super(reason);
    this.status = status;
    this.retryable = retryable;
    this.rateLimited = !!rate;
    this.retryAfterMs = rate?.retryAfterMs ?? null;
  }
}

function isAddPath(u: string): boolean {
  try {
    return /\/cart\/add(\.js)?$/.test(new URL(u).pathname);
  } catch {
    return false;
  }
}

async function waitForQuiet(page: Page, inflight: { n: number }, quietMs = 400, maxMs = 5000): Promise<void> {
  const start = Date.now();
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    if (inflight.n > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return;
    await page.waitForTimeout(50);
  }
}

function normalizeStored(body: NonNullable<Awaited<ReturnType<typeof readStoredCart>>['body']>): StoredCart {
  const currency = String(body.currency ?? '');
  return {
    currency,
    itemCount: Number(body.item_count ?? 0),
    totalMinor: shopifyCentsToIsoMinor(Number(body.total_price ?? 0), currency),
    lines: (body.items ?? []).map((i) => ({
      variantId: Number(i.variant_id),
      productTitle: i.product_title,
      variantTitle: i.variant_title ?? 'Default Title',
      quantity: Number(i.quantity),
      finalLinePriceMinor: shopifyCentsToIsoMinor(Number(i.final_line_price), currency),
    })),
  };
}

// Shopify storefront password gate (development stores, pre-launch stores). The password is set from memory into the
// page's own form and submitted; it never enters URLs, logs, results or screenshots.
async function passPasswordGate(page: Page, origin: string, password: string, gate: { open: boolean }): Promise<void> {
  gate.open = true;
  try {
    await page.goto(origin + '/password', { waitUntil: 'domcontentloaded' });
    if (!new URL(page.url()).pathname.startsWith('/password')) return; // storefront is not password-protected
    const hasForm = await page.evaluate(() => !!document.querySelector('form[action$="/password"] input[name="password"]'));
    if (!hasForm) throw new Stop('UNSUPPORTED', 'storefront password page has no password form');
    const left = page.waitForURL((u) => !u.pathname.startsWith('/password'), { timeout: 15_000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate((pw) => {
      const f = document.querySelector('form[action$="/password"]') as HTMLFormElement;
      (f.querySelector('input[name="password"]') as HTMLInputElement).value = pw;
      setTimeout(() => f.submit(), 0);
    }, password);
    await left;
    if (new URL(page.url()).pathname.startsWith('/password')) throw new Stop('BLOCKED', 'storefront password rejected');
  } finally {
    gate.open = false;
  }
}

async function attempt(browser: Browser, spec: CaseSpec, opts: RunOptions, timeoutMs: number): Promise<Attempt> {
  const policy: SafetyPolicy = { authorizedDomains: spec.authorizedDomains, allowLoopbackFixture: opts.allowLoopbackFixture };
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    context.close().catch(() => {});
  }, timeoutMs);
  const blocked: string[] = [];
  const gate = { open: false };
  let passwordWall = false;
  let theme: Attempt['theme'] = { schema: null, version: null, adapter: null, surface: null };
  let adapter: AdapterName | null = null;
  let market: MarketObservation | null = null;
  let stored: StoredCart | null = null;
  let visible: VisibleCart | null = null;
  const checks: Check[] = [];
  let page: Page | null = null;
  try {
    await context.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const gatePath = u.pathname === '/password' || u.pathname.startsWith('/password/');
      if (gatePath && gate.open && hostAuthorized(u.hostname, policy)) return route.continue();
      const d = await allowRequest(req.url(), req.isNavigationRequest(), policy);
      if (!d.ok) {
        if (gatePath && req.isNavigationRequest()) passwordWall = true;
        blocked.push(`${d.why}`);
        return route.abort('blockedbyclient');
      }
      if (opts.inject && req.method() === 'POST' && isAddPath(req.url())) {
        if (opts.inject.kind === 'stale-drawer') {
          const resp = await route.fetch();
          const json = (await resp.json()) as Record<string, unknown>;
          delete json.sections;
          return route.fulfill({ response: resp, json });
        }
        const body = req.postData() ?? '';
        const swapped = body.split(String(opts.inject.from)).join(String(opts.inject.to));
        if (swapped !== body) return route.continue({ postData: swapped });
      }
      return route.continue();
    });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const password = opts.storefrontPasswords?.[new URL(spec.lines[0].url).hostname.toLowerCase()];
    page = await context.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    // A request counts as settled at its response (bodies a theme never reads may never emit requestfinished).
    const pending = new Set<unknown>();
    const inflight = {
      get n() {
        return pending.size;
      },
    };
    page.on('request', (r) => pending.add(r));
    page.on('response', (r) => pending.delete(r.request()));
    page.on('requestfinished', (r) => pending.delete(r));
    page.on('requestfailed', (r) => pending.delete(r));

    const gateHost = new URL(spec.lines[0].url).hostname.toLowerCase();
    const cachedGate = password ? opts.gateCookies?.get(gateHost) : undefined;
    if (password && cachedGate) {
      await context.addCookies(cachedGate);
    } else if (password) {
      const first = await assertCaseUrl(spec.lines[0].url, policy);
      await passPasswordGate(page, first.origin, password, gate);
      if (opts.gateCookies) {
        const digest = (await context.cookies()).filter((c) => c.name === 'storefront_digest');
        if (digest.length) opts.gateCookies.set(gateHost, digest as GateCookie[]);
      }
    }

    for (let i = 0; i < spec.lines.length; i++) {
      const line = spec.lines[i];
      await assertCaseUrl(line.url, policy);
      const resp = await page.goto(line.url, { waitUntil: 'domcontentloaded' });
      // Playwright routes only see the first hop of a redirect chain, so the landing document is re-checked here.
      const landed = new URL(page.url());
      if (landed.pathname === '/password' || landed.pathname.startsWith('/password/')) {
        if (cachedGate) {
          opts.gateCookies?.delete(gateHost); // digest expired: the single retry unlocks again
          throw new Stop('ERROR', 'storefront password session expired', true);
        }
        passwordWall = true;
        throw new Stop('BLOCKED', 'storefront is password-protected; supply its storefront password (never in URLs)');
      }
      if (!hostAuthorized(landed.hostname, policy)) throw new Stop('UNSUPPORTED', `navigation left the owner-authorized domain (landed on ${landed.hostname})`);
      const code = resp?.status() ?? 0;
      const ctx = await page.evaluate(readPageContext);
      if (i === 0) theme = { schema: ctx.themeSchema, version: ctx.themeVersion, adapter: adapterForSchema(ctx.themeSchema), surface: null };
      if (code === 429) throw new Stop('BLOCKED', `storefront rate limited (HTTP 429)`, false, { retryAfterMs: parseRetryAfter(resp?.headers()['retry-after'], Date.now()) });
      if (ctx.challenge) throw new Stop('BLOCKED', `storefront blocked automation (HTTP ${code}, challenge page)`);
      if (code >= 500) throw new Stop('ERROR', `product page HTTP ${code}`, true);
      if (code >= 400) throw new Stop('UNSUPPORTED', `product page HTTP ${code}`);
      if (i === 0) {
        market = verifyMarket(spec.market, ctx.country, ctx.currency);
        checks.push({ name: 'market.verified', ok: market.verified, detail: `requested ${spec.market.country}/${spec.market.currency}; ${market.evidence}` });
        if (!market.verified) throw new Stop('UNSUPPORTED', `requested market ${spec.market.country}/${spec.market.currency} not verified in-session (observed ${ctx.country ?? 'null'}/${ctx.currency ?? 'null'})`);
        const pre = await page.evaluate(readStoredCart);
        if (pre.status === 429) throw new Stop('BLOCKED', 'stored cart rate limited before add (HTTP 429)', false, { retryAfterMs: null });
        if (!pre.ok || !pre.body) throw new Stop('ERROR', `stored cart unreadable before add (HTTP ${pre.status})`, pre.status >= 500);
        if (Number(pre.body.item_count ?? 0) !== 0) throw new Stop('ERROR', 'session not isolated: cart not empty before first add', true);
      }
      const adapterName = adapterForSchema(ctx.themeSchema);
      if (!adapterName || !ctx.hasProductForm) {
        throw new Stop('UNSUPPORTED', `no supported adapter: theme schema "${ctx.themeSchema ?? 'unknown'}"${ctx.hasProductForm ? '' : ', no product form'}`);
      }
      adapter = adapterName;
      const sel = ADAPTERS[adapterName].selectors;
      const selected = await page.inputValue(sel.variantInput).catch(() => null);
      const preselected = selected !== null && Number(selected) === line.variantId;
      checks.push({ name: 'theme.variantSelection', ok: preselected, detail: `requested variant ${line.variantId}, product form selected ${selected ?? 'none'}` });
      if (line.quantity !== 1) {
        const q = await page.$(sel.quantityInput);
        if (!q) throw new Stop('UNSUPPORTED', 'quantity input not found; cannot request quantity > 1');
        await q.fill(String(line.quantity));
      }
      const respP = page.waitForResponse((r) => isAddPath(r.url()) && r.request().method() === 'POST', { timeout: 0 });
      await page.click(sel.addButton);
      const addResp = await respP;
      const addCode = addResp.status();
      if (addCode === 429) throw new Stop('BLOCKED', 'add-to-cart rate limited (HTTP 429)', false, { retryAfterMs: parseRetryAfter(addResp.headers()['retry-after'], Date.now()) });
      if (addCode >= 500) throw new Stop('ERROR', `add-to-cart HTTP ${addCode}`, true);
      if (addCode >= 400) throw new Stop('UNSUPPORTED', `store rejected add-to-cart (HTTP ${addCode}); variant unavailable?`);
      await waitForQuiet(page, inflight);
      await page.waitForTimeout(250);
    }

    const raw = await page.evaluate(readStoredCart);
    if (raw.status === 429) throw new Stop('BLOCKED', 'stored cart rate limited (HTTP 429)', false, { retryAfterMs: null });
    if (!raw.ok || !raw.body) throw new Stop('ERROR', `stored cart unreadable (HTTP ${raw.status})`, raw.status >= 500);
    stored = normalizeStored(raw.body);

    // Surface: a theme that renders a cart drawer is tested ON the drawer. A stale or closed drawer is never
    // replaced by a (server-rendered, healthy) cart page; only themes without a drawer are read on /cart.
    const ad = adapter as AdapterName;
    const sel = ADAPTERS[ad].selectors;
    let surface: 'drawer' | 'cart-page' = 'drawer';
    if (await page.$(sel.drawer)) {
      const autoOpened = await page.evaluate(drawerIsOpen, ad);
      checks.push({ name: 'surface.drawer.autoOpen', ok: true, detail: autoOpened ? 'drawer opened after add' : 'drawer stayed closed after add; opened from the header cart control' });
      if (!autoOpened) {
        await page.click(sel.drawerTrigger).catch(() => {});
        await page.waitForTimeout(500);
      }
    } else {
      surface = 'cart-page';
      const root = await page.evaluate(readPageContext).then((c) => c.routesRoot);
      await page.goto(new URL(root + 'cart', page.url()).toString(), { waitUntil: 'domcontentloaded' });
    }
    theme.surface = surface;
    const rv = await page.evaluate(readVisibleCartAny, { surface, adapter: ad });
    if (surface === 'drawer' && !rv.drawerOpen) throw new Stop('UNSUPPORTED', 'cart drawer present but could not be opened; drawer not verified (cart page not substituted)');
    const base = page.url();
    visible = {
      surface,
      badgeDeclared: ADAPTERS[ad].declaresBadge,
      badgeCount: rv.badgeText === null ? null : Number.parseInt(rv.badgeText, 10),
      totalText: rv.totalText,
      lines: rv.lines.map((l) => {
        let variantId: number | null = null;
        if (l.href) {
          const v = new URL(l.href, base).searchParams.get('variant');
          variantId = v ? Number(v) : null;
        }
        return { variantId, title: l.title, options: l.options, quantity: l.quantity === null ? null : Number.parseInt(l.quantity, 10), priceText: l.priceText };
      }),
    };
    const verdict = classify(market!, spec.lines, stored, visible, { badge: spec.checks?.badge ?? ADAPTERS[ad].declaresBadge, total: totalMode(spec.checks?.total) });
    const allChecks = [...checks, ...verdict.checks];
    let status = verdict.status;
    let reason = verdict.reason;
    const selFail = checks.find((c) => c.name === 'theme.variantSelection' && !c.ok);
    if (selFail && status === 'PASS') {
      status = 'REGRESSION';
      reason = `theme did not select the requested variant: ${selFail.detail}`;
    }
    const shot = status === 'PASS' ? null : await screenshot(page, spec.id, opts);
    return { status, reason, checks: allChecks, market, stored, visible, screenshot: shot, retryable: false, rateLimited: false, retryAfterMs: null, theme };
  } catch (e) {
    const base = { checks, market, stored, visible, theme, rateLimited: false, retryAfterMs: null as number | null };
    if (passwordWall && !(e instanceof Stop)) {
      return { ...base, status: 'BLOCKED', reason: 'storefront is password-protected; supply its storefront password (never in URLs)', screenshot: null, retryable: false };
    }
    if (timedOut) {
      return { ...base, status: 'ERROR', reason: `case timeout after ${timeoutMs} ms`, screenshot: null, retryable: true };
    }
    if (e instanceof Stop) {
      const shot = page && !page.isClosed() ? await screenshot(page, spec.id, opts) : null;
      return { ...base, status: e.status, reason: e.message, screenshot: shot, retryable: e.retryable, rateLimited: e.rateLimited, retryAfterMs: e.retryAfterMs };
    }
    if (e instanceof SafetyError) return { ...base, status: 'UNSUPPORTED', reason: `refused by safety policy: ${e.message}`, screenshot: null, retryable: false };
    const msg = (e as Error).message?.split('\n')[0] ?? String(e);
    return { ...base, status: 'ERROR', reason: `engine error: ${msg}${blocked.length ? ` (blocked: ${blocked.slice(0, 3).join(', ')})` : ''}`, screenshot: null, retryable: true };
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
}

async function screenshot(page: Page, id: string, opts: RunOptions): Promise<string | null> {
  if (!opts.screenshotDir) return null;
  const path = `${opts.screenshotDir}/${id}.png`;
  try {
    await page.screenshot({
      path,
      mask: [page.locator('input[type="email"], input[type="password"], input[type="tel"], input[name*="email" i], [data-redact], .customer, .header__icon--account')],
    });
    return path;
  } catch {
    return null;
  }
}

// Should this attempt be retried (once, in a fresh context)? Retryable ERROR or a 429.
export function retryWorthy(a: { status: Status; retryable?: boolean; rateLimited?: boolean }): boolean {
  return (a.status === 'ERROR' && !!a.retryable) || (a.status === 'BLOCKED' && !!a.rateLimited);
}

function caseHost(spec: CaseSpec): string {
  return new URL(spec.lines[0].url).hostname.toLowerCase();
}

function deadlineBlocked(spec: CaseSpec, opts: RunOptions, waitMs: number): Attempt {
  return { status: 'BLOCKED', reason: `queued: store cooldown (${Math.ceil(waitMs / 1000)} s) would start this case after the job deadline; credit released, retry later`, checks: [], market: null, stored: null, visible: null, screenshot: null, retryable: false, rateLimited: false, retryAfterMs: waitMs, theme: { schema: null, version: null, adapter: null, surface: null } };
}

// One attempt, paced: waits for the store's slot (outside any page), then runs, then feeds the outcome back.
export async function pacedAttempt(browser: Browser, spec: CaseSpec, opts: RunOptions): Promise<{ a: Attempt; waitedMs: number; startedAt: string | null }> {
  const timeoutMs = Math.min(spec.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const host = caseHost(spec);
  let waitedMs = 0;
  if (opts.pacer) {
    const slot = await opts.pacer.acquire(host, opts.deadlineAt);
    if (!slot) return { a: deadlineBlocked(spec, opts, opts.pacer.waitMs(host)), waitedMs: 0, startedAt: null };
    waitedMs = slot.waitedMs;
  }
  const startedAt = new Date().toISOString();
  const a = await attempt(browser, spec, opts, timeoutMs);
  opts.pacer?.record(host, { rateLimited: a.rateLimited, retryAfterMs: a.retryAfterMs });
  return { a, waitedMs, startedAt };
}

export function toCaseResult(spec: CaseSpec, opts: RunOptions, a: Attempt, attempts: number, durationMs: number, pacing: { waitedMs: number; rateLimited: boolean; retryAfterMs: number | null; attemptStarts: string[] }): CaseResult {
  return {
    caseId: spec.id,
    kind: 'single',
    engineVersion: opts.engineVersion,
    source: { urls: spec.lines.map((l) => sanitizeUrl(l.url)), evidenceClass: spec.evidenceClass },
    requested: { market: spec.market, lines: spec.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) },
    market: a.market,
    stored: a.stored,
    visible: a.visible,
    status: a.status,
    reason: a.reason,
    checks: a.checks,
    durationMs,
    attempts,
    cost: { measured: false, usd: 'UNKNOWN', basis: 'local runtime; not a provider invoice' },
    screenshot: a.screenshot,
    casesConsumed: 1,
    theme: a.theme,
    pacing,
  };
}

export type { Attempt };

export async function runCase(browser: Browser, spec: CaseSpec, opts: RunOptions): Promise<CaseResult> {
  const t0 = Date.now();
  let r = await pacedAttempt(browser, spec, opts);
  let attempts = 1;
  let waited = r.waitedMs;
  let anyRateLimited = r.a.rateLimited;
  let lastRetryAfter = r.a.retryAfterMs;
  const starts = r.startedAt ? [r.startedAt] : [];
  if (opts.retry !== 'none' && retryWorthy(r.a)) {
    attempts = 2;
    r = await pacedAttempt(browser, spec, opts); // fresh isolated context; a 429 is never a pass
    waited += r.waitedMs;
    anyRateLimited ||= r.a.rateLimited;
    lastRetryAfter = r.a.retryAfterMs ?? lastRetryAfter;
    if (r.startedAt) starts.push(r.startedAt);
  }
  const a = r.a;
  return toCaseResult(spec, opts, a, attempts, Date.now() - t0, { waitedMs: waited, rateLimited: anyRateLimited, retryAfterMs: lastRetryAfter, attemptStarts: starts });
}

export async function runPair(browser: Browser, spec: PairSpec, opts: RunOptions): Promise<CaseResult> {
  const t0 = Date.now();
  const live = await runCase(browser, spec.live, opts);
  const candidate = await runCase(browser, spec.candidate, opts);
  return pairResult(spec, opts, live, candidate, Date.now() - t0);
}

// Combines two completed single results (live, candidate) into the pair result. Used by runPair and by the hosted
// runner, which runs the two halves in separate browser sessions with the store's pacing wait in between.
export function pairResult(spec: PairSpec, opts: RunOptions, live: CaseResult, candidate: CaseResult, durationMs: number): CaseResult {
  const v = comparePair(live, candidate);
  return {
    caseId: spec.id,
    kind: 'pair',
    engineVersion: opts.engineVersion,
    source: { urls: [...live.source.urls, ...candidate.source.urls], evidenceClass: spec.live.evidenceClass },
    requested: candidate.requested,
    market: candidate.market,
    stored: candidate.stored,
    visible: candidate.visible,
    status: v.status,
    reason: v.reason,
    checks: v.checks,
    durationMs,
    attempts: live.attempts + candidate.attempts,
    cost: { measured: false, usd: 'UNKNOWN', basis: 'local runtime; not a provider invoice' },
    screenshot: candidate.screenshot ?? live.screenshot,
    casesConsumed: 2,
    parts: [live, candidate],
  };
}
