// Pacing (Retry-After, backoff ceiling, concurrent cooldown), bounded retry in a fresh session, credit idempotency,
// and the theme/surface matrix (Dawn 15/16, Horizon 4.4 × drawer/page) on the synthetic fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGrant } from '../api/ledger.ts';
import { licenseHash, mockVerifier } from '../api/payhip.ts';
import { runPaidJob, type ServiceConfig } from '../api/service.ts';
import { openSqlite } from '../api/sqlite.ts';
import { launchBrowser } from '../engine/launch.ts';
import { backoffMs, DEFAULT_PACING, parseRetryAfter, StorePacer, type Clock } from '../engine/pacing.ts';
import { runCase } from '../engine/runner.ts';
import { startFixture } from '../fixtures/storefront/server.ts';
import { runMatrix } from '../scripts/theme-matrix.ts';
import type { CaseSpec } from '../engine/types.ts';

function fakeClock(start = 1_000_000): Clock & { t: number; sleeps: number[] } {
  const c = { t: start, sleeps: [] as number[], now: () => c.t, async sleep(ms: number) { c.sleeps.push(ms); c.t += ms; }, random: () => 0.5 };
  return c;
}

test('Retry-After parsing: seconds, HTTP date, invalid', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7000);
  assert.equal(parseRetryAfter('Sat, 07 Nov 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Sat, 07 Nov 2026 11:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('backoff doubles with jitter and never exceeds the ceiling', () => {
  const p = { ...DEFAULT_PACING, baseBackoffMs: 1000, maxBackoffMs: 10_000, jitterRatio: 0.2 };
  assert.equal(backoffMs(0, p, () => 0.5), 1000);
  assert.equal(backoffMs(2, p, () => 0.5), 4000);
  for (const r of [0, 0.25, 0.75, 0.9999]) {
    const v = backoffMs(1, p, () => r);
    assert.ok(v >= 1600 && v <= 2400, `jitter bound ${v}`);
  }
  for (let level = 0; level < 20; level++) assert.ok(backoffMs(level, p, () => 0.9999) <= 10_000);
});

test('per-store pacer: concurrent callers queue, 429 honours Retry-After (capped), other stores independent', async () => {
  const clock = fakeClock();
  const pacer = new StorePacer({ minIntervalMs: 15_000, baseBackoffMs: 30_000, maxBackoffMs: 120_000, jitterRatio: 0 }, clock);
  const [a, b, c] = await Promise.all([pacer.acquire('shop.example'), pacer.acquire('SHOP.example'), pacer.acquire('other.example')]);
  assert.equal(a!.waitedMs, 0);
  assert.equal(b!.waitedMs, 15_000, 'second caller on the same store waits one interval');
  assert.equal(c!.waitedMs, 0, 'another store is not delayed');
  pacer.record('shop.example', { rateLimited: true, retryAfterMs: 60_000 });
  assert.ok(pacer.waitMs('shop.example') >= 60_000);
  pacer.record('shop.example', { rateLimited: true, retryAfterMs: 10 * 60_000 });
  assert.ok(pacer.waitMs('shop.example') <= 120_000, 'Retry-After is capped by maxBackoffMs');
  assert.equal(await pacer.acquire('shop.example', clock.now() + 1000), null, 'a slot after the job deadline is refused, not waited for');
});

test('bounded retry: a 429 is retried once in a fresh session, never counted as PASS; credits move once', async (t) => {
  const cleanup: (() => unknown)[] = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  });
  const fixture = await startFixture(0);
  cleanup.push(() => fixture.close());
  const browser = await launchBrowser(true);
  cleanup.push(() => browser.close());
  const host = new URL(fixture.url).hostname;
  const spec = (id: string, sc: string): CaseSpec => ({ id, adapter: 'dawn', market: { country: 'IE', currency: 'EUR' }, authorizedDomains: [host], evidenceClass: 'synthetic-fixture', lines: [{ url: `${fixture.url}/s/${sc}/products/linen-shirt?variant=4101&country=IE`, variantId: 4101, quantity: 1 }] });
  const pacer = new StorePacer({ minIntervalMs: 50, baseBackoffMs: 200, maxBackoffMs: 2000, jitterRatio: 0 });
  const opts = { engineVersion: 't003', allowLoopbackFixture: true, screenshotDir: null, pacer };
  const once = await runCase(browser, spec('once', 'rate-limit-once'), opts);
  assert.equal(once.status, 'PASS', once.reason);
  assert.equal(once.attempts, 2);
  assert.equal(once.pacing?.rateLimited, true);
  assert.ok((once.pacing?.waitedMs ?? 0) >= 900, 'waited for Retry-After: 1 before the retry');
  const always = await runCase(browser, spec('always', 'rate-limit-always'), opts);
  assert.equal(always.status, 'BLOCKED');
  assert.equal(always.attempts, 2, 'at most one retry');
  // Credits: the retried PASS consumes once, the terminal BLOCKED releases once.
  const dir = mkdtempSync(join(tmpdir(), 'mcci-t003-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openSqlite(join(dir, 'l.sqlite'));
  cleanup.push(() => db.close());
  const KEY = 'TTTTT-UUUUU-VVVVV-WWWWW';
  const cfg: ServiceConfig = { db, verifier: mockVerifier(new Map([[KEY, { enabled: true, product_link: 'MCCI1', uses: 0, date: '' }]])), productLink: 'MCCI1', pepper: 'p', payhipApiKey: 'k' };
  const r1 = await runPaidJob(cfg, KEY, 'job-retry', 2, async () => [once, always]);
  assert.ok(r1.ok && !r1.replay && r1.consumed === 1 && r1.released === 1);
  const r2 = await runPaidJob(cfg, KEY, 'job-retry', 2, async () => { throw new Error('must not execute again'); });
  assert.ok(r2.ok && r2.replay);
  const g = (await getGrant(db, licenseHash('p', KEY)))!;
  assert.deepEqual([g.available, g.reserved, g.consumed], [99, 0, 1]);
});

test('theme/surface matrix: Dawn 15.4.1, Dawn 16.1.1, Horizon 4.4.0 × drawer/page, 0 false PASS', async (t) => {
  const cleanup: (() => unknown)[] = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  });
  const fixture = await startFixture(0);
  cleanup.push(() => fixture.close());
  const browser = await launchBrowser(true);
  cleanup.push(() => browser.close());
  const rows = await runMatrix(browser, fixture.url, new URL(fixture.url).hostname, true);
  const wrong = rows.filter((r) => r.status !== r.expected);
  assert.deepEqual(wrong, [], JSON.stringify(wrong, null, 1));
  for (const r of rows.filter((x) => x.scenario !== 'non-existent-market')) {
    assert.equal(r.surface, r.skin.endsWith('drawer') ? 'drawer' : 'cart-page', `${r.skin} ${r.scenario} surface`);
    assert.equal(r.adapter, r.skin.startsWith('horizon') ? 'horizon' : 'dawn');
  }
  assert.ok(rows.filter((r) => r.scenario === 'stale-drawer').every((r) => r.status === 'REGRESSION'), 'a stale drawer is never replaced by the cart page');
});
