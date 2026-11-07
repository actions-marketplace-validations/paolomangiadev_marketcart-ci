// Atomic credit ledger: grant -> reserve -> complete (consume billable, release the rest) -> revoke.
// Storage-agnostic: `batch` must run its statements atomically (local SQLite transaction or a Cloudflare D1 batch).

export type SqlParam = string | number | null;
export interface Stmt {
  sql: string;
  params: SqlParam[];
}
export interface Db {
  batch(stmts: Stmt[]): Promise<{ changes: number }[]>;
  get<T>(sql: string, params: SqlParam[]): Promise<T | undefined>;
  all<T>(sql: string, params: SqlParam[]): Promise<T[]>;
}

export interface GrantRow {
  license_hash: string;
  product_link: string;
  credits_total: number;
  available: number;
  reserved: number;
  consumed: number;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
  is_test: number;
}
export interface JobRow {
  job_id: string;
  license_hash: string;
  cases_reserved: number;
  state: 'reserved' | 'completed';
  applied: number;
  settled: number;
  consumed: number;
  released: number;
  created_at: number;
  completed_at: number | null;
  result_json: string | null;
}

export const PACK_CREDITS = 100;
export const PACK_VALIDITY_MS = 30 * 24 * 3600 * 1000;

export async function getGrant(db: Db, licenseHash: string): Promise<GrantRow | undefined> {
  return db.get<GrantRow>('SELECT * FROM grants WHERE license_hash = ?', [licenseHash]);
}
export async function getJob(db: Db, jobId: string): Promise<JobRow | undefined> {
  return db.get<JobRow>('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
}

// Idempotent: a replayed activation returns the existing grant and never adds credits.
export async function grantPack(db: Db, licenseHash: string, productLink: string, now: number, isTest: boolean): Promise<{ grant: GrantRow; created: boolean }> {
  const [r] = await db.batch([
    {
      sql: `INSERT INTO grants (license_hash, product_link, credits_total, available, granted_at, expires_at, is_test)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(license_hash) DO NOTHING`,
      params: [licenseHash, productLink, PACK_CREDITS, PACK_CREDITS, now, now + PACK_VALIDITY_MS, isTest ? 1 : 0],
    },
  ]);
  const grant = (await getGrant(db, licenseHash))!;
  return { grant, created: r.changes === 1 };
}

export type ReserveOutcome =
  | { ok: true; job: JobRow; replay: boolean }
  | { ok: false; reason: 'unknown_license' | 'revoked' | 'expired' | 'insufficient_credits' };

export async function reserve(db: Db, jobId: string, licenseHash: string, cases: number, now: number): Promise<ReserveOutcome> {
  const before = await getJob(db, jobId);
  if (before) return before.license_hash === licenseHash ? { ok: true, job: before, replay: true } : { ok: false, reason: 'unknown_license' };
  await db.batch([
    {
      sql: `INSERT OR IGNORE INTO jobs (job_id, license_hash, cases_reserved, state, created_at)
            SELECT ?, license_hash, ?, 'reserved', ? FROM grants
            WHERE license_hash = ? AND revoked_at IS NULL AND expires_at > ? AND available >= ?`,
      params: [jobId, cases, now, licenseHash, now, cases],
    },
    {
      sql: `UPDATE grants SET available = available - ?, reserved = reserved + ?
            WHERE license_hash = ? AND EXISTS (SELECT 1 FROM jobs WHERE job_id = ? AND license_hash = ? AND applied = 0)`,
      params: [cases, cases, licenseHash, jobId, licenseHash],
    },
    { sql: `UPDATE jobs SET applied = 1 WHERE job_id = ? AND applied = 0`, params: [jobId] },
  ]);
  const job = await getJob(db, jobId);
  if (job && job.license_hash === licenseHash) return { ok: true, job, replay: false };
  const g = await getGrant(db, licenseHash);
  if (!g) return { ok: false, reason: 'unknown_license' };
  if (g.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (g.expires_at <= now) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'insufficient_credits' };
}

// Idempotent: a duplicate completion callback changes nothing.
export async function complete(db: Db, jobId: string, consumed: number, now: number, resultJson: string): Promise<{ job: JobRow; applied: boolean }> {
  const job = await getJob(db, jobId);
  if (!job) throw new Error('unknown job');
  if (job.state === 'completed') return { job, applied: false };
  const c = Math.max(0, Math.min(consumed, job.cases_reserved));
  const released = job.cases_reserved - c;
  await db.batch([
    {
      sql: `UPDATE jobs SET state = 'completed', consumed = ?, released = ?, completed_at = ?, result_json = ?
            WHERE job_id = ? AND state = 'reserved' AND applied = 1`,
      params: [c, released, now, resultJson, jobId],
    },
    {
      sql: `UPDATE grants SET reserved = reserved - (SELECT consumed + released FROM jobs WHERE job_id = ?),
                              consumed = consumed + (SELECT consumed FROM jobs WHERE job_id = ?),
                              available = available + (SELECT released FROM jobs WHERE job_id = ?)
            WHERE license_hash = (SELECT license_hash FROM jobs WHERE job_id = ?)
              AND EXISTS (SELECT 1 FROM jobs WHERE job_id = ? AND state = 'completed' AND settled = 0)`,
      params: [jobId, jobId, jobId, jobId, jobId],
    },
    { sql: `UPDATE jobs SET settled = 1 WHERE job_id = ? AND state = 'completed' AND settled = 0`, params: [jobId] },
  ]);
  const after = (await getJob(db, jobId))!;
  return { job: after, applied: true };
}

// Release reservations whose runner never reported back (crash, lost callback).
export async function releaseStale(db: Db, olderThanMs: number, now: number): Promise<number> {
  const stale = await db.all<JobRow>(`SELECT * FROM jobs WHERE state = 'reserved' AND created_at < ?`, [now - olderThanMs]);
  for (const j of stale) await complete(db, j.job_id, 0, now, JSON.stringify({ released: 'stale reservation' }));
  return stale.length;
}

export async function revoke(db: Db, licenseHash: string, reason: string, now: number): Promise<boolean> {
  const [r] = await db.batch([{ sql: `UPDATE grants SET revoked_at = ?, revoke_reason = ? WHERE license_hash = ? AND revoked_at IS NULL`, params: [now, reason, licenseHash] }]);
  return r.changes === 1;
}
