// Theme/surface matrix on the SYNTHETIC fixture skins (Dawn 15.4.1 / 16.1.1 / Horizon 4.4.0 × drawer / page).
// Kept separate from the frozen 20-case benchmark. `node scripts/theme-matrix.ts` writes evidence/theme-matrix/<run>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { runCase } from '../engine/runner.ts';
import type { CaseSpec, Status } from '../engine/types.ts';
import { SKINS, skinInfo, type Skin } from '../fixtures/storefront/skins.ts';

export interface MatrixRow { skin: Skin; scenario: string; expected: Status; status: Status; surface: string | null; adapter: string | null; version: string | null; attempts: number; reason: string }

// Scenario set per surface. Drawer skins must catch stale drawer/badge (never substituted by the cart page).
export function matrixCases(skin: Skin): { scenario: string; expected: Status; qty?: number; total?: boolean; variant?: number }[] {
  const drawer = skinInfo(skin).drawer;
  const common = [
    { scenario: 'healthy', expected: 'PASS' as Status },
    { scenario: 'healthy', expected: 'PASS' as Status, qty: 2 },
    { scenario: 'wrong-variant', expected: 'REGRESSION' as Status, variant: 4102 },
    { scenario: 'qty-clamp', expected: 'REGRESSION' as Status, qty: 3 },
    { scenario: 'visible-wrong-amount', expected: 'REGRESSION' as Status },
    { scenario: 'visible-wrong-symbol', expected: 'REGRESSION' as Status },
    { scenario: 'cart-currency-usd', expected: 'REGRESSION' as Status },
    { scenario: 'non-existent-market', expected: 'UNSUPPORTED' as Status },
  ];
  return drawer
    ? [...common, { scenario: 'stale-drawer', expected: 'REGRESSION' }, { scenario: 'stale-badge', expected: 'REGRESSION' }, { scenario: 'drawer-no-open', expected: 'PASS' }]
    : [...common, { scenario: 'missing-total', expected: 'UNSUPPORTED', total: true }, { scenario: 'stale-qty', expected: 'REGRESSION', qty: 2 }];
}

export async function runMatrix(browser: Browser, base: string, host: string, loopback: boolean): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  for (const skin of SKINS) {
    for (const c of matrixCases(skin)) {
      const variant = c.variant ?? 4101;
      const sc = c.scenario === 'non-existent-market' ? 'healthy' : c.scenario;
      const spec: CaseSpec = {
        id: `${skin}:${c.scenario}${c.qty ? `:q${c.qty}` : ''}`,
        adapter: 'dawn',
        market: c.scenario === 'non-existent-market' ? { country: 'JP', currency: 'JPY' } : { country: 'IE', currency: 'EUR' },
        authorizedDomains: [host],
        evidenceClass: 'synthetic-fixture',
        lines: [{ url: `${base}/k/${skin}/s/${sc}/products/linen-shirt?variant=${variant}&country=IE`, variantId: variant, quantity: c.qty ?? 1 }],
        checks: c.total ? { total: true } : undefined,
      };
      const r = await runCase(browser, spec, { engineVersion: 'matrix', allowLoopbackFixture: loopback, screenshotDir: null });
      rows.push({ skin, scenario: spec.id.split(':').slice(1).join(':'), expected: c.expected, status: r.status, surface: r.theme?.surface ?? null, adapter: r.theme?.adapter ?? null, version: r.theme?.version ?? null, attempts: r.attempts, reason: r.reason.slice(0, 200) });
    }
  }
  return rows;
}

if ((process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/theme-matrix.ts')) {
  const { launchBrowser } = await import('../engine/launch.ts');
  const { startFixture } = await import('../fixtures/storefront/server.ts');
  const { engineVersion } = await import('../engine/cli.ts');
  const remote = process.env.MARKETCART_FIXTURE_BASE?.replace(/\/$/, '');
  const fixture = remote ? { url: remote, close: async () => {} } : await startFixture(0);
  const browser = await launchBrowser(true);
  try {
    const rows = await runMatrix(browser, fixture.url, new URL(fixture.url).hostname, !remote);
    const correct = rows.filter((r) => r.status === r.expected).length;
    const falsePass = rows.filter((r) => r.status === 'PASS' && r.expected !== 'PASS').length;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dir = join(import.meta.dirname, '..', 'evidence', 'theme-matrix');
    mkdirSync(dir, { recursive: true });
    const summary = { run: `matrix-${remote ? 'remote-' : ''}${stamp}`, engineVersion: engineVersion(), evidenceClass: 'synthetic-fixture', total: rows.length, correct, falsePass };
    writeFileSync(join(dir, `${summary.run}.json`), JSON.stringify({ summary, rows }, null, 2));
    for (const r of rows) console.log(`${r.skin.padEnd(17)} ${r.scenario.padEnd(24)} ${r.expected.padEnd(11)} ${r.status.padEnd(11)} ${r.surface ?? '-'} ${r.adapter ?? '-'}@${r.version ?? '-'}`);
    console.log(JSON.stringify(summary));
    process.exitCode = correct === rows.length && falsePass === 0 ? 0 : 1;
  } finally {
    await browser.close();
    await fixture.close();
  }
}
