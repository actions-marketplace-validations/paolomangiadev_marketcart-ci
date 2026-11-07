// Per-store pacing: one cart cycle per store at a time, a minimum interval between cycles, Retry-After honoured,
// otherwise bounded exponential backoff with jitter after HTTP 429. No proxy/IP rotation, no anti-bot bypass.
// Waits happen here, BEFORE a browser session is opened, so pacing never burns browser seconds.

export interface PacingPolicy {
  minIntervalMs: number; // gap between the start of two cart cycles on the same store
  baseBackoffMs: number; // first backoff after a 429 without Retry-After
  maxBackoffMs: number; // ceiling for any wait (Retry-After included)
  jitterRatio: number; // +/- fraction applied to computed backoff
}

// Three-second gaps produced HTTP 429 on a Shopify development store after ~4 cycles (2026-11-07); start at 15 s.
export const DEFAULT_PACING: PacingPolicy = { minIntervalMs: 15_000, baseBackoffMs: 30_000, maxBackoffMs: 300_000, jitterRatio: 0.2 };

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number; // [0, 1)
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))), random: Math.random };

// Retry-After: delta-seconds or an HTTP date. Returns milliseconds from `now`, or null when absent/invalid.
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}

export function backoffMs(level: number, policy: PacingPolicy, random: () => number): number {
  const raw = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** Math.max(0, level));
  const jitter = 1 + (random() * 2 - 1) * policy.jitterRatio;
  return Math.min(policy.maxBackoffMs, Math.round(raw * jitter));
}

export interface PacerState {
  nextAt: number; // earliest start of the next cart cycle
  level: number; // consecutive 429s (backoff exponent)
}

export interface AcquireResult {
  waitedMs: number;
  startedAt: number;
}

export class StorePacer {
  readonly policy: PacingPolicy;
  readonly clock: Clock;
  private state = new Map<string, PacerState>();

  constructor(policy: PacingPolicy = DEFAULT_PACING, clock: Clock = realClock, initial?: Record<string, PacerState>) {
    this.policy = policy;
    this.clock = clock;
    for (const [k, v] of Object.entries(initial ?? {})) this.state.set(k, { ...v });
  }

  snapshot(): Record<string, PacerState> {
    return Object.fromEntries([...this.state].map(([k, v]) => [k, { ...v }]));
  }

  // How long a new cycle on `host` would wait right now.
  waitMs(host: string): number {
    const s = this.state.get(host.toLowerCase());
    return s ? Math.max(0, s.nextAt - this.clock.now()) : 0;
  }

  // Reserves the next slot synchronously (so concurrent callers queue behind each other), then sleeps until it.
  // Returns null without sleeping when the slot would start after `deadlineAt`.
  async acquire(host: string, deadlineAt = Number.POSITIVE_INFINITY): Promise<AcquireResult | null> {
    const key = host.toLowerCase();
    const now = this.clock.now();
    const s = this.state.get(key) ?? { nextAt: 0, level: 0 };
    const slot = Math.max(now, s.nextAt);
    if (slot > deadlineAt) return null;
    s.nextAt = slot + this.policy.minIntervalMs;
    this.state.set(key, s);
    if (slot > now) await this.clock.sleep(slot - now);
    return { waitedMs: slot - now, startedAt: slot };
  }

  // Feed back the outcome of a cycle. A 429 pushes the store's next slot out (Retry-After or backoff).
  record(host: string, outcome: { rateLimited: boolean; retryAfterMs?: number | null }): number {
    const key = host.toLowerCase();
    const now = this.clock.now();
    const s = this.state.get(key) ?? { nextAt: now, level: 0 };
    if (outcome.rateLimited) {
      const wait = outcome.retryAfterMs != null ? Math.min(this.policy.maxBackoffMs, outcome.retryAfterMs) : backoffMs(s.level, this.policy, this.clock.random);
      s.level += 1;
      s.nextAt = Math.max(s.nextAt, now + Math.max(wait, this.policy.minIntervalMs));
    } else {
      s.level = 0;
      s.nextAt = Math.max(s.nextAt, now + this.policy.minIntervalMs);
    }
    this.state.set(key, s);
    return s.nextAt - now;
  }
}
