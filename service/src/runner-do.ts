// Browser runner Durable Object: drives one Cloudflare Browser Run session per job with OUR engine.
// Why a Durable Object: an ordinary Worker request on the Free plan has a 10 ms CPU budget, which a real Shopify
// product page exceeds (Error 1102 observed 2026-11-07 on the dev store); a Durable Object invocation gets 30 s of CPU.
// One named instance ('browser-runner') serializes executions (concurrency 1) on top of the D1 lease.
import { DurableObject } from 'cloudflare:workers';
import { launch } from '@cloudflare/playwright';
import type { Browser } from 'playwright-core';
import { runCase, runPair, type GateCookie, type RunOptions } from '../../engine/runner.ts';
import { dohResolver, setResolver } from '../../engine/safety.ts';
import type { CaseResult, CaseSpec, PairSpec } from '../../engine/types.ts';

setResolver(dohResolver());

export type RunnerItem = { single: CaseSpec } | { pair: PairSpec };
export interface RunnerJob {
  allowed: string[]; // Browser Run guardrail allowlist (platform-enforced egress)
  items: RunnerItem[];
  passwords: Record<string, string>; // host -> storefront password, memory only
  pauseMs: number;
  engineVersion: string;
}
export interface RunnerStats { wallMs: number; sessionMs: number; launchRetries: number }

interface RunnerEnv { BROWSER: { fetch: typeof fetch } }

export class BrowserRunner extends DurableObject<RunnerEnv> {
  private busy: Promise<unknown> = Promise.resolve();

  async execute(job: RunnerJob): Promise<{ results: CaseResult[]; stats: RunnerStats }> {
    const run = this.busy.then(() => this.executeNow(job));
    this.busy = run.catch(() => {});
    return run;
  }

  private async executeNow(job: RunnerJob): Promise<{ results: CaseResult[]; stats: RunnerStats }> {
    let browser: Browser | null = null;
    let retries = 0;
    for (;;) {
      try {
        browser = (await launch(this.env.BROWSER, { keep_alive: 30_000, guardrails: { allowedDomains: job.allowed.slice(0, 50), allowedDomainSets: ['common-cdns'] } })) as unknown as Browser;
        break;
      } catch (e) {
        if (retries >= 3 || !/429|rate limit/i.test(String(e))) throw new Error(`runner unavailable: ${String(e).slice(0, 120)}`);
        retries++;
        await new Promise((r) => setTimeout(r, 6_000 * retries));
      }
    }
    const s0 = Date.now();
    const results: CaseResult[] = [];
    try {
      const opts: RunOptions = { engineVersion: job.engineVersion, allowLoopbackFixture: false, screenshotDir: null, storefrontPasswords: job.passwords, gateCookies: new Map<string, GateCookie[]>() };
      for (const item of job.items) {
        if (results.length && job.pauseMs > 0) await new Promise((r) => setTimeout(r, Math.min(job.pauseMs, 10_000)));
        results.push('pair' in item ? await runPair(browser, item.pair, opts) : await runCase(browser, item.single, opts));
      }
    } finally {
      await browser.close().catch(() => {});
    }
    return { results, stats: { wallMs: 0, sessionMs: Date.now() - s0, launchRetries: retries } };
  }
}
