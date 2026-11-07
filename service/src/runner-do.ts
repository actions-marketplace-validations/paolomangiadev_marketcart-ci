// Browser runner Durable Object: OUR engine on Cloudflare Browser Run, one named instance ('browser-runner').
// Why a Durable Object: a Free-plan Worker request has a 10 ms CPU budget, which a real Shopify product page exceeds
// (Error 1102, 2026-11-07); a Durable Object invocation gets 30 s of CPU.
// Pacing: one per-store StorePacer shared by every job and client, persisted in DO storage. Each cart
// cycle gets its OWN short browser session and every wait (store cooldown, Retry-After, backoff) happens BEFORE the
// session is opened, so waits never consume Browser Run seconds. At most one retry per case, in a fresh session.
import { DurableObject } from 'cloudflare:workers';
import { launch } from '@cloudflare/playwright';
import type { Browser } from 'playwright-core';
import { DEFAULT_PACING, StorePacer, type PacerState } from '../../engine/pacing.ts';
import { pairResult, retryWorthy, runCase, toCaseResult, type GateCookie, type RunOptions } from '../../engine/runner.ts';
import { dohResolver, setResolver } from '../../engine/safety.ts';
import type { CaseResult, CaseSpec, PairSpec } from '../../engine/types.ts';

setResolver(dohResolver());

export type RunnerItem = { single: CaseSpec } | { pair: PairSpec };
export interface RunnerJob {
  allowed: string[]; // Browser Run guardrail allowlist (platform-enforced egress)
  items: RunnerItem[];
  passwords: Record<string, string>; // host -> storefront password, memory only
  pauseMs: number; // legacy minimum gap override (ms); the store pacer's interval applies on top
  engineVersion: string;
  deadlineAt?: number; // epoch ms: a cart cycle that cannot START before this is returned BLOCKED (queued), released
  unpacedHosts?: string[]; // our own synthetic fixture: no store to protect, no pacing
}
export interface RunnerStats { wallMs: number; sessionMs: number; launchRetries: number; sessions: number; waitedMs: number }

interface RunnerEnv { BROWSER: { fetch: typeof fetch } }
interface DoStorage { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }

export class BrowserRunner extends DurableObject<RunnerEnv> {
  private busy: Promise<unknown> = Promise.resolve();
  private pacer: StorePacer | null = null;

  private get storage(): DoStorage {
    return (this.ctx as { storage: DoStorage }).storage;
  }

  private async loadPacer(): Promise<StorePacer> {
    if (!this.pacer) {
      const saved = (await this.storage.get<Record<string, PacerState>>('pacer')) ?? {};
      this.pacer = new StorePacer(DEFAULT_PACING, undefined, saved);
    }
    return this.pacer;
  }

  private async savePacer(): Promise<void> {
    if (this.pacer) await this.storage.put('pacer', this.pacer.snapshot());
  }

  // Milliseconds until each host could start a cart cycle (for admission before credits are reserved).
  async queueEstimate(hosts: string[]): Promise<Record<string, number>> {
    const pacer = await this.loadPacer();
    return Object.fromEntries(hosts.map((h) => [h, pacer.waitMs(h)]));
  }

  async execute(job: RunnerJob): Promise<{ results: CaseResult[]; stats: RunnerStats }> {
    const run = this.busy.then(() => this.executeNow(job));
    this.busy = run.catch(() => {});
    return run;
  }

  private async session<T>(job: RunnerJob, stats: RunnerStats, fn: (b: Browser) => Promise<T>): Promise<T> {
    let browser: Browser | null = null;
    let retries = 0;
    for (;;) {
      try {
        browser = (await launch(this.env.BROWSER, { keep_alive: 10_000, guardrails: { allowedDomains: job.allowed.slice(0, 50), allowedDomainSets: ['common-cdns'] } })) as unknown as Browser;
        break;
      } catch (e) {
        if (retries >= 3 || !/429|rate limit/i.test(String(e))) throw new Error(`runner unavailable: ${String(e).slice(0, 120)}`);
        retries++;
        await new Promise((r) => setTimeout(r, 6_000 * retries)); // browser not open yet: no browser seconds used
      }
    }
    stats.launchRetries += retries;
    stats.sessions += 1;
    const s0 = Date.now();
    try {
      return await fn(browser);
    } finally {
      await browser.close().catch(() => {});
      stats.sessionMs += Date.now() - s0;
    }
  }

  // One case: wait for the store slot (no browser open), run in a fresh session, record the outcome; one retry.
  private async oneCase(spec: CaseSpec, job: RunnerJob, stats: RunnerStats, gateCookies: Map<string, GateCookie[]>): Promise<CaseResult> {
    const pacer = await this.loadPacer();
    const host = new URL(spec.lines[0].url).hostname.toLowerCase();
    const opts: RunOptions = { engineVersion: job.engineVersion, allowLoopbackFixture: false, screenshotDir: null, storefrontPasswords: job.passwords, gateCookies, retry: 'none' };
    const t0 = Date.now();
    const starts: string[] = [];
    let waited = 0;
    let rateLimited = false;
    let retryAfterMs: number | null = null;
    let last: CaseResult | null = null;
    const paced = !(job.unpacedHosts ?? []).includes(host);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const slot = paced ? await pacer.acquire(host, job.deadlineAt) : { waitedMs: 0, startedAt: Date.now() };
      await this.savePacer();
      if (!slot) {
        const waitMs = pacer.waitMs(host);
        const queued = toCaseResult(spec, opts, { status: 'BLOCKED', reason: `queued: store cooldown (${Math.ceil(waitMs / 1000)} s) would start this case after the job deadline; credit released, retry later`, checks: [], market: null, stored: null, visible: null, screenshot: null, retryable: false, rateLimited: false, retryAfterMs: waitMs, theme: { schema: null, version: null, adapter: null, surface: null } }, Math.max(1, attempt - 1), Date.now() - t0, { waitedMs: waited, rateLimited, retryAfterMs: waitMs, attemptStarts: starts });
        return last && attempt > 1 ? { ...last, attempts: attempt - 1 } : queued;
      }
      waited += slot.waitedMs;
      stats.waitedMs += slot.waitedMs;
      starts.push(new Date().toISOString());
      const r = await this.session(job, stats, (b) => runCase(b, spec, opts));
      if (paced) pacer.record(host, { rateLimited: !!r.pacing?.rateLimited, retryAfterMs: r.pacing?.retryAfterMs ?? null });
      await this.savePacer();
      rateLimited ||= !!r.pacing?.rateLimited;
      retryAfterMs = r.pacing?.retryAfterMs ?? retryAfterMs;
      last = r;
      if (!retryWorthy({ status: r.status, retryable: r.status === 'ERROR', rateLimited: r.pacing?.rateLimited })) break;
    }
    return { ...last!, attempts: starts.length, durationMs: Date.now() - t0, pacing: { waitedMs: waited, rateLimited, retryAfterMs, attemptStarts: starts } };
  }

  private async executeNow(job: RunnerJob): Promise<{ results: CaseResult[]; stats: RunnerStats }> {
    const t0 = Date.now();
    const stats: RunnerStats = { wallMs: 0, sessionMs: 0, launchRetries: 0, sessions: 0, waitedMs: 0 };
    const gateCookies = new Map<string, GateCookie[]>();
    const results: CaseResult[] = [];
    for (const item of job.items) {
      if ('pair' in item) {
        const p0 = Date.now();
        const live = await this.oneCase(item.pair.live, job, stats, gateCookies);
        const candidate = await this.oneCase(item.pair.candidate, job, stats, gateCookies);
        results.push(pairResult(item.pair, { engineVersion: job.engineVersion, allowLoopbackFixture: false, screenshotDir: null }, live, candidate, Date.now() - p0));
      } else {
        results.push(await this.oneCase(item.single, job, stats, gateCookies));
      }
    }
    stats.wallMs = Date.now() - t0;
    return { results, stats };
  }
}
