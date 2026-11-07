// Targeted regression tests (kept separate from the frozen 20-case empirical benchmark table).
//   1. Board finding: an explicitly required total that is absent/unreadable/currency-less must never PASS.
//   2. Storefront password gate: blocked without password, rejected on a wrong one, never leaked into results.
//   3. Runtime-neutral SSRF resolver (DoH for the Worker runtime), fail-closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, totalMode, verifyMarket } from '../engine/assert.ts';
import { launchBrowser } from '../engine/launch.ts';
import { runCase } from '../engine/runner.ts';
import { assertCaseUrl, dohResolver, ipFamily, nodeResolver, setResolver } from '../engine/safety.ts';
import { FIXTURE_STOREFRONT_PASSWORD } from '../fixtures/storefront/app.ts';
import { startFixture } from '../fixtures/storefront/server.ts';
import type { CaseSpec, StoredCart, VisibleCart } from '../engine/types.ts';

const market = verifyMarket({ country: 'IE', currency: 'EUR' }, 'IE', 'EUR');
const stored: StoredCart = { currency: 'EUR', itemCount: 1, totalMinor: 2400, lines: [{ variantId: 4101, productTitle: 'Linen Shirt', variantTitle: 'Red / M', quantity: 1, finalLinePriceMinor: 2400 }] };
const visible = (totalText: string | null): VisibleCart => ({
  surface: 'drawer', badgeDeclared: true, badgeCount: 1, totalText,
  lines: [{ variantId: 4101, title: 'Linen Shirt', options: ['Red', 'M'], quantity: 1, priceText: '€24.00' }],
});
const req = [{ variantId: 4101, quantity: 1 }];
const run = (totalText: string | null, flag: boolean | undefined) => classify(market, req, stored, visible(totalText), { badge: true, total: totalMode(flag) });

test('required total: absent, unreadable or currency-less is inconclusive, never PASS', () => {
  for (const t of [null, 'soon', '24.00']) {
    const v = run(t, true);
    assert.equal(v.status, 'UNSUPPORTED', `total ${t}: ${v.reason}`);
  }
  assert.equal(run('€24.00', true).status, 'PASS');
  assert.equal(run('€20.00', true).status, 'REGRESSION');
  assert.equal(run('$24.00', true).status, 'REGRESSION');
});

test('optional total (default) keeps documented semantics; off skips it', () => {
  const absent = run(null, undefined);
  assert.equal(absent.status, 'PASS');
  assert.ok(absent.checks.some((c) => c.name === 'visible.total.absent' && c.ok));
  const noIndicator = run('24.00', undefined);
  assert.equal(noIndicator.status, 'PASS');
  assert.ok(noIndicator.checks.some((c) => c.name === 'visible.total.currency.unverified'));
  assert.equal(run('20.00', undefined).status, 'REGRESSION'); // amount still checked
  assert.equal(run('soon', undefined).status, 'UNSUPPORTED'); // shown but unreadable: inconclusive, not PASS
  assert.equal(run('$24.00', undefined).status, 'REGRESSION');
  assert.equal(run(null, false).status, 'PASS');
  assert.ok(!run('$99.00', false).checks.some((c) => c.name.startsWith('visible.total')));
});

test('storefront password gate: blocked without password, rejected when wrong, PASS when right, never leaked', async (t) => {
  const cleanup: (() => unknown)[] = []; // LIFO
  t.after(async () => {
    for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  });
  const fixture = await startFixture(0);
  cleanup.push(() => fixture.close());
  const browser = await launchBrowser(true);
  cleanup.push(() => browser.close());
  const spec: CaseSpec = { id: 'pw', adapter: 'dawn', market: { country: 'IE', currency: 'EUR' }, authorizedDomains: ['127.0.0.1'], evidenceClass: 'synthetic-fixture', lines: [{ url: `${fixture.url}/s/password-gate/products/linen-shirt?variant=4101&country=IE`, variantId: 4101, quantity: 1 }] };
  const host = new URL(fixture.url).hostname;
  const base = { engineVersion: 't002', allowLoopbackFixture: true, screenshotDir: null };
  const none = await runCase(browser, spec, base);
  assert.equal(none.status, 'BLOCKED', none.reason);
  assert.equal(none.attempts, 1, 'password wall is not retried');
  const wrong = await runCase(browser, spec, { ...base, storefrontPasswords: { [host]: 'not-the-password' } });
  assert.equal(wrong.status, 'BLOCKED', wrong.reason);
  assert.match(wrong.reason, /rejected/);
  const right = await runCase(browser, spec, { ...base, storefrontPasswords: { [host]: FIXTURE_STOREFRONT_PASSWORD } });
  assert.equal(right.status, 'PASS', right.reason);
  for (const r of [none, wrong, right]) {
    const out = JSON.stringify(r);
    assert.ok(!out.includes(FIXTURE_STOREFRONT_PASSWORD) && !out.includes('not-the-password'), 'password must never appear in results');
  }
});

test('runtime-neutral SSRF resolver: DoH answers are checked, failures close', async (t) => {
  t.after(() => setResolver(nodeResolver));
  assert.equal(ipFamily('23.227.38.65'), 4);
  assert.equal(ipFamily('2606:4700::1111'), 6);
  assert.equal(ipFamily('shop.example.com'), 0);
  assert.equal(ipFamily('999.1.1.1'), 0);
  const fake = (answers: Record<string, string[]>) => (async (u: string | URL) => {
    const p = new URL(String(u));
    const type = p.searchParams.get('type');
    const data = (answers[p.searchParams.get('name') ?? ''] ?? []).filter((a) => (type === 'A' ? ipFamily(a) === 4 : ipFamily(a) === 6));
    return new Response(JSON.stringify({ Status: 0, Answer: data.map((d) => ({ type: type === 'A' ? 1 : 28, data: d })) }), { headers: { 'content-type': 'application/dns-json' } });
  }) as typeof fetch;
  const policy = (d: string) => ({ authorizedDomains: [d], allowLoopbackFixture: false });
  setResolver(dohResolver('https://doh.test/dns-query', fake({ 'shop.example.com': ['23.227.38.65'], 'rebind.example.com': ['23.227.38.65', '10.0.0.7'] })));
  await assertCaseUrl('https://shop.example.com/products/x', policy('shop.example.com'));
  await assert.rejects(assertCaseUrl('https://rebind.example.com/products/x', policy('rebind.example.com')), /private/);
  await assert.rejects(assertCaseUrl('https://nxdomain.example.com/products/x', policy('nxdomain.example.com')), /private|unresolvable/);
  setResolver(dohResolver('https://doh.test/dns-query', (async () => new Response('down', { status: 503 })) as typeof fetch));
  await assert.rejects(assertCaseUrl('https://shop.example.com/products/x', policy('shop.example.com')), /unresolvable/);
});
