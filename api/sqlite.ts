// Local Db implementation on node:sqlite (D1 is SQLite too; production swaps this for env.DB.batch()).

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, SqlParam, Stmt } from './ledger.ts';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function openSqlite(path: string, migrate = true): Db & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  if (migrate) db.exec(readFileSync(SCHEMA, 'utf8'));
  return {
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = stmts.map((s) => ({ changes: Number(db.prepare(s.sql).run(...(s.params as SqlParam[])).changes) }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async get<T>(sql: string, params: SqlParam[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: SqlParam[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    close() {
      db.close();
    },
  };
}
