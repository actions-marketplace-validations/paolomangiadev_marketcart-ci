#!/usr/bin/env node
// MarketCart CI command line.
//   node engine/cli.ts bench            full 20-case synthetic benchmark; exits 1 if acceptance fails
//   node engine/cli.ts demo             3-case seeded fixture demo (no key, no network beyond 127.0.0.1)
//   node engine/cli.ts check FILE.json  run owner-authorized cases (see docs); exit 0 PASS, 1 REGRESSION, 2 inconclusive
// Output: machine-readable JSON + a short human table.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixtures/storefront/server.ts';
import { launchBrowser } from './launch.ts';
import { runCase, runPair } from './runner.ts';
import { StorePacer } from './pacing.ts';
import { findSecrets } from './safety.ts';
import type { CaseResult, CaseSpec, Market, PairSpec, Status } from './types.ts';

export const ENGINE_SEMVER = '0.1.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export function engineVersion(): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(HERE);
  const h = createHash('sha256');
  for (const f of files) h.update(relative(HERE, f).replace(/\\/g, '/')).update(readFileSync(f));
  return `${ENGINE_SEMVER}+${h.digest('hex').slice(0, 8)}`;
}

interface ManifestCase {
  id: string;
  group: string;
  expected: Status;
  reason: string;
  kind: 'single' | 'pair';
  scenario?: string;
  live?: { scenario: string };
  candidate?: { scenario: string };
  market: Market;
  lines: { product: string; variantId: number; quantity: number }[];
  checks?: { badge?: boolean };
  timeoutMs?: number;
}

function fixtureSpec(base: string, id: string, scenario: string, c: ManifestCase, candidate = false): CaseSpec {
  return {
    id,
    adapter: 'dawn',
    market: c.market,
    evidenceClass: 'synthetic-fixture',
    authorizedDomains: [new URL(base).hostname],
    timeoutMs: c.timeoutMs,
    checks: c.checks,
    lines: c.lines.map((l) => ({
      url: `${base}/s/${scenario}/products/${l.product}?variant=${l.variantId}&country=${c.market.country}${candidate ? '&preview_theme_id=fixture-candidate' : ''}`,
      variantId: l.variantId,
      quantity: l.quantity,
    })),
  };
}

function table(rows: { id: string; expected?: string; status: string; ms: number; reason: string }[]): string {
  const out = ['| Case | Expected | Actual | ms | Reason |', '|---|---|---|---:|---|'];
  for (const r of rows) out.push(`| ${r.id} | ${r.expected ?? '-'} | ${r.status} | ${r.ms} | ${r.reason.replace(/\|/g, '/').slice(0, 160)} |`);
  return out.join('\n');
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function runManifest(ids: string[] | null, label: string): Promise<{ results: (CaseResult & { expected: Status })[]; runDir: string; version: string; wallMs: number }> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'evidence/benchmark-manifest.json'), 'utf8')) as { cases: ManifestCase[] };
  const cases = ids ? manifest.cases.filter((c) => ids.includes(c.id)) : manifest.cases;
  const version = engineVersion();
  const runId = `${label}${process.env.MARKETCART_FIXTURE_BASE ? '-remote' : ''}-${stamp()}`;
  const runDir = join(ROOT, 'evidence/runs', runId);
  mkdirSync(runDir, { recursive: true });
  const remote = process.env.MARKETCART_FIXTURE_BASE; // e.g. the public deployed fixture; default = local 127.0.0.1 server
  const fixture = remote ? { url: remote.replace(/[/]$/, ''), close: async () => {} } : await startFixture(0);
  const browser = await launchBrowser(true);
  const t0 = Date.now();
  const results: (CaseResult & { expected: Status })[] = [];
  try {
    for (const c of cases) {
      const opts = { engineVersion: version, allowLoopbackFixture: !remote, screenshotDir: runDir };
      let r: CaseResult;
      if (c.kind === 'pair') {
        const spec: PairSpec = { id: c.id, live: fixtureSpec(fixture.url, `${c.id}-live`, c.live!.scenario, c), candidate: fixtureSpec(fixture.url, `${c.id}-candidate`, c.candidate!.scenario, c, true) };
        r = await runPair(browser, spec, opts);
      } else {
        r = await runCase(browser, fixtureSpec(fixture.url, c.id, c.scenario!, c), opts);
      }
      if (r.screenshot) r.screenshot = relative(ROOT, r.screenshot).replace(/\\/g, '/');
      for (const p of r.parts ?? []) if (p.screenshot) p.screenshot = relative(ROOT, p.screenshot).replace(/\\/g, '/');
      results.push({ ...r, expected: c.expected });
      process.stdout.write(`${c.id} ${r.status.padEnd(11)} (expected ${c.expected}) ${r.durationMs} ms\n`);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
  return { results, runDir, version, wallMs: Date.now() - t0 };
}

async function bench(ids: string[] | null): Promise<number> {
  const { results, runDir, version, wallMs } = await runManifest(ids, ids ? 'rerun' : 'bench');
  const total = results.length;
  const correct = results.filter((r) => r.status === r.expected).length;
  const falsePass = results.filter((r) => r.status === 'PASS' && r.expected !== 'PASS').length;
  const plantedRegressions = results.filter((r) => r.expected === 'REGRESSION');
  const detected = plantedRegressions.filter((r) => r.status === 'REGRESSION').length;
  const serialized = JSON.stringify(results);
  const secrets = findSecrets(serialized);
  const full = total === 20;
  const accepted = full && correct >= 19 && detected === plantedRegressions.length && falsePass === 0 && secrets.length === 0;
  const summary = {
    runId: runDir.split(/[\\/]/).pop(),
    engineVersion: version,
    evidenceClass: 'synthetic-fixture',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    startedAt: new Date(Date.now() - wallMs).toISOString(),
    wallMs,
    total,
    correct,
    falsePass,
    plantedRegressions: plantedRegressions.length,
    regressionsDetected: detected,
    secretsFound: secrets,
    casesConsumed: results.reduce((a, r) => a + r.casesConsumed, 0),
    attempts: results.reduce((a, r) => a + r.attempts, 0),
    accepted: full ? accepted : 'PARTIAL RUN (acceptance needs all 20)',
  };
  writeFileSync(join(runDir, 'results.json'), JSON.stringify({ summary, results }, null, 2));
  const human = table(results.map((r) => ({ id: r.caseId, expected: r.expected, status: r.status, ms: r.durationMs, reason: r.reason })));
  const md = `# Benchmark run ${summary.runId}\n\nEngine ${version} · ${summary.evidenceClass} · ${summary.platform} · Node ${process.version} · wall ${wallMs} ms\n\nCorrect ${correct}/${total} · planted regressions detected ${detected}/${plantedRegressions.length} · false PASS ${falsePass} · secrets ${secrets.length} · accepted: ${summary.accepted}\n\n${human}\n`;
  writeFileSync(join(runDir, 'summary.md'), md);
  const hist = join(ROOT, 'evidence/benchmark-history.md');
  if (!existsSync(hist)) writeFileSync(hist, '# Benchmark history (append-only; failures preserved)\n\n| Run | Engine | Cases | Correct | Regressions detected | False PASS | Secrets | Accepted | Wall ms |\n|---|---|---:|---:|---:|---:|---:|---|---:|\n');
  appendFileSync(hist, `| ${summary.runId} | ${version} | ${total} | ${correct} | ${detected}/${plantedRegressions.length} | ${falsePass} | ${secrets.length} | ${summary.accepted} | ${wallMs} |\n`);
  console.log('\n' + md);
  console.log(`results: ${relative(ROOT, join(runDir, 'results.json'))}`);
  if (full) return accepted ? 0 : 1;
  return correct === total && falsePass === 0 && secrets.length === 0 ? 0 : 1;
}

async function demo(): Promise<number> {
  const { results, runDir } = await runManifest(['C01', 'C05', 'C16'], 'demo');
  writeFileSync(join(runDir, 'results.json'), JSON.stringify({ demo: true, evidenceClass: 'synthetic-fixture', results }, null, 2));
  console.log('\nSeeded fixture demo (synthetic store, planted defects; not a claim about any live theme):\n');
  console.log(table(results.map((r) => ({ id: r.caseId, expected: r.expected, status: r.status, ms: r.durationMs, reason: r.reason }))));
  const ok = results.every((r) => r.status === r.expected);
  return ok ? 0 : 1;
}

interface CheckFile {
  authorizedDomains: string[];
  cases: ({ id: string; market: Market; lines: { url: string; variantId: number; quantity: number }[]; checks?: { badge?: boolean } } & { candidate?: { lines: { url: string; variantId: number; quantity: number }[] } })[];
}

async function check(file: string): Promise<number> {
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as CheckFile;
  const version = engineVersion();
  const browser = await launchBrowser(true);
  const results: CaseResult[] = [];
  const pacer = new StorePacer(); // same per-store policy as the hosted runner (15 s between cart cycles, 429 backoff)
  try {
    for (const c of cfg.cases) {
      const base: CaseSpec = { id: c.id, adapter: 'dawn', market: c.market, lines: c.lines, authorizedDomains: cfg.authorizedDomains, evidenceClass: 'live-shopify', checks: c.checks };
      const opts = { engineVersion: version, allowLoopbackFixture: false, screenshotDir: null, pacer };
      results.push(c.candidate ? await runPair(browser, { id: c.id, live: { ...base, id: `${c.id}-live` }, candidate: { ...base, id: `${c.id}-candidate`, lines: c.candidate.lines } }, opts) : await runCase(browser, base, opts));
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ engineVersion: version, results }, null, 2));
  console.error(table(results.map((r) => ({ id: r.caseId, status: r.status, ms: r.durationMs, reason: r.reason }))));
  if (results.some((r) => r.status === 'REGRESSION')) return 1;
  if (results.some((r) => r.status !== 'PASS')) return 2;
  return 0;
}

const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('engine/cli.ts');
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = async () => {
    if (cmd === 'bench') return bench(args.length ? args : null);
    if (cmd === 'demo') return demo();
    if (cmd === 'check' && args[0]) return check(args[0]);
    console.error('usage: cli.ts bench [CASE_ID...] | demo | check FILE.json');
    return 64;
  };
  run().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(70);
    },
  );
}
