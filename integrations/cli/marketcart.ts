#!/usr/bin/env node
// MarketCart CI public command line wrapper.
//   marketcart                         help and quickstart (no network, no browser)
//   marketcart setup-browser           installs the headless Chromium build matching the bundled playwright-core
//   marketcart demo                    seeded synthetic-fixture demo, runs locally, no key, no network beyond 127.0.0.1
//   marketcart bench                   full 20-case synthetic benchmark (same as the published evidence)
//   marketcart check CASES.json        local check of YOUR store with your own browser (free, no key)
//   marketcart remote CASES.json       hosted check of YOUR authorized store (needs MARKETCART_LICENSE)
//   marketcart token HOST              prints the meta tag that proves you control HOST
// Exit status: 0 all PASS · 1 at least one REGRESSION · 2 inconclusive only (BLOCKED/UNSUPPORTED/ERROR)
//              3 API / license / credit error · 64 usage error
// Run from the repository (node integrations/cli/marketcart.ts) it uses engine/cli.ts directly. Installed as a package
// (npx / npm), Node cannot strip TypeScript types inside node_modules, so it runs engine/cli.bundle.js: the same
// frozen engine source bundled to JavaScript by scripts/build-package.ts (no engine code changes).
// Environment: MARKETCART_API_URL (hosted API base URL; default https://marketcart-ci.pages.dev),
//              MARKETCART_LICENSE (Payhip license key; store it as a CI secret, never in the repo),
//              MARKETCART_STOREFRONT_PASSWORD (only for password-protected stores; CI secret, sent once over HTTPS),
//              MARKETCART_JOB_ID (idempotency key; default derived from the CI run), MARKETCART_SOURCE (attribution tag).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Package root: bin/marketcart.js -> .. ; integrations/cli/marketcart.ts -> ../..
const ROOT = existsSync(join(HERE, '..', 'package.json')) ? join(HERE, '..') : join(HERE, '..', '..');
const FROM_SOURCE = import.meta.url.endsWith('.ts');
// The launcher makes the bundled engine see itself as engine/cli.ts, exactly as `node engine/cli.ts <cmd>` would.
const ENGINE_CLI = FROM_SOURCE ? join(ROOT, 'engine', 'cli.ts') : join(ROOT, 'engine', 'run.js');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const HELP = `marketcart-ci ${VERSION} (command-line wrapper) · engine frozen at release v0.2.0
Checks that a Shopify cart drawer or cart page shows what /cart.js stored (Dawn family, Horizon 4.4).

Quickstart (no account, synthetic store with planted bugs; downloads a headless Chromium once, ~100 MB):
  npx github:paolomangiadev/marketcart-ci setup-browser
  npx github:paolomangiadev/marketcart-ci demo

Commands:
  setup-browser [--with-deps]  install the headless Chromium matching this package (Linux CI: --with-deps)
  demo                         3 seeded cases on a local synthetic store; exit 0 when they behave as expected
  bench                        the full 20-case synthetic benchmark
  check CASES.json             check YOUR store locally with your own browser (free, no key)
  remote CASES.json            hosted check of YOUR store (MARKETCART_LICENSE; no local browser)
  token HOST                   meta tag proving you control HOST (MARKETCART_LICENSE)
  --version | --help

Exit status: 0 all PASS · 1 REGRESSION · 2 inconclusive only · 3 API/license error · 64 usage error
Workflow generator: https://marketcart-ci.pages.dev/tools/github-action-generator/?src=cli-help`;

const DEFAULT_API = 'https://marketcart-ci.pages.dev';
function apiBase(): string | null {
  const v = process.env.MARKETCART_API_URL || DEFAULT_API;
  return v.replace(/\/$/, '');
}

function table(results: { caseId: string; status: string; durationMs: number; reason: string }[]): string {
  const rows = results.map((r) => `| ${r.caseId} | ${r.status} | ${r.durationMs ?? '-'} | ${(r.reason ?? '').replace(/\|/g, '/').slice(0, 140)} |`);
  return ['| Case | Status | ms | Reason |', '|---|---|---:|---|', ...rows].join('\n');
}

async function remote(file: string): Promise<number> {
  const base = apiBase();
  const key = process.env.MARKETCART_LICENSE;
  if (!base || !key) {
    console.error('MARKETCART_API_URL and MARKETCART_LICENSE are required for hosted checks. The local demo needs neither: marketcart demo');
    return 3;
  }
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const jobId = process.env.MARKETCART_JOB_ID ?? `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? Date.now()}`;
  const r = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-marketcart-source': process.env.MARKETCART_SOURCE ?? 'cli' },
    body: JSON.stringify({
      jobId,
      authorizedDomains: cfg.authorizedDomains,
      cases: cfg.cases,
      source: process.env.MARKETCART_SOURCE ?? 'cli',
      storefrontPasswords: process.env.MARKETCART_STOREFRONT_PASSWORD ? Object.fromEntries((cfg.authorizedDomains as string[]).map((d) => [d, process.env.MARKETCART_STOREFRONT_PASSWORD])) : undefined,
    }),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string; results?: { caseId: string; status: string; durationMs: number; reason: string }[]; consumed?: number; released?: number; available?: number };
  if (!r.ok || !data.results) {
    console.error(`hosted check failed (HTTP ${r.status}): ${data.error ?? 'unknown error'}`);
    return 3;
  }
  writeFileSync('marketcart-results.json', JSON.stringify(data, null, 2));
  console.log(table(data.results));
  console.log(`\ncredits consumed ${data.consumed}, released ${data.released}, remaining ${data.available} · full JSON: marketcart-results.json`);
  if (data.results.some((x) => x.status === 'REGRESSION')) return 1;
  if (data.results.some((x) => x.status !== 'PASS')) return 2;
  return 0;
}

async function token(host: string): Promise<number> {
  const base = apiBase();
  const key = process.env.MARKETCART_LICENSE;
  if (!base || !key) return (console.error('MARKETCART_API_URL and MARKETCART_LICENSE are required'), 3);
  const r = await fetch(`${base}/v1/domain-token?host=${encodeURIComponent(host)}`, { headers: { authorization: `Bearer ${key}` } });
  const d = (await r.json().catch(() => ({}))) as { meta?: string; error?: string };
  if (!r.ok || !d.meta) return (console.error(`failed (HTTP ${r.status}): ${d.error ?? ''}`), 3);
  console.log(`Add this tag inside <head> of ${host} (theme.liquid), then run hosted checks:\n${d.meta}`);
  return 0;
}

function local(args: string[]): number {
  const r = spawnSync(process.execPath, [ENGINE_CLI, ...args], { stdio: 'inherit' });
  return r.status ?? 70;
}

// Explicit, user-invoked browser download (never a postinstall step): playwright-core's own installer, same version.
function setupBrowser(withDeps: boolean): number {
  const req = createRequire(join(ROOT, 'package.json'));
  const cli = join(dirname(req.resolve('playwright-core/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', ...(withDeps ? ['--with-deps'] : []), 'chromium-headless-shell'], { stdio: 'inherit' });
  return r.status ?? 70;
}

const [cmd, arg] = process.argv.slice(2);
const main = async (): Promise<number> => {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return (console.log(HELP), 0);
  if (cmd === '--version' || cmd === '-v') return (console.log(VERSION), 0);
  if (cmd === 'setup-browser') return setupBrowser(arg === '--with-deps');
  if (cmd === 'demo' || cmd === 'bench') return local([cmd]);
  if (cmd === 'check' && arg) return local(['check', arg]);
  if (cmd === 'remote' && arg) return remote(arg);
  if (cmd === 'token' && arg) return token(arg);
  console.error('usage: marketcart [setup-browser | demo | bench | check CASES.json | remote CASES.json | token HOST | --help]');
  return 64;
};
main().then((c) => process.exit(c), (e) => (console.error(e), process.exit(3)));
