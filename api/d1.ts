// Cloudflare D1 adapter for the storage-agnostic ledger (api/ledger.ts). A D1 batch runs as one transaction, so the
// conditional multi-statement reserve/complete groups keep the same atomicity as the local BEGIN IMMEDIATE batches.
import type { Db, SqlParam, Stmt } from './ledger.ts';

// Minimal structural types (no dependency on @cloudflare/workers-types in the shared code).
export interface D1Prepared {
  bind(...values: SqlParam[]): D1Prepared;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1Prepared;
  batch(stmts: D1Prepared[]): Promise<{ meta: { changes?: number } }[]>;
}

export function d1Db(d1: D1Like): Db {
  const prep = (s: Stmt) => d1.prepare(s.sql).bind(...s.params);
  return {
    async batch(stmts: Stmt[]) {
      const res = await d1.batch(stmts.map(prep));
      return res.map((r) => ({ changes: Number(r.meta?.changes ?? 0) }));
    },
    async get<T>(sql: string, params: SqlParam[]) {
      return ((await d1.prepare(sql).bind(...params).first<T>()) ?? undefined) as T | undefined;
    },
    async all<T>(sql: string, params: SqlParam[]) {
      return (await d1.prepare(sql).bind(...params).all<T>()).results;
    },
  };
}
