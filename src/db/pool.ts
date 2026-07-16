/**
 * PostgreSQL connection pool for Cinderella's archive DB.
 *
 * This is the *archive* database (messages, links, consent) — entirely separate
 * from the SimpleX core's own SQLite DB.
 */

import { Pool } from 'pg';
import { loadConfig } from '../config.js';

/**
 * The minimal query surface the DB layer depends on. Both `pg.Pool` and
 * `pg.PoolClient` satisfy it, which also lets tests inject an alternative
 * Postgres engine (e.g. an in-process one) without pulling in a live server.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: loadConfig().databaseUrl });
  }
  return pool;
}

/** Verifies the DB is reachable; throws with a clear message otherwise. */
export async function assertDbReachable(db: Queryable = getPool()): Promise<void> {
  await db.query('SELECT 1');
}

/** Runs `fn` inside a transaction on a dedicated pooled client. */
export async function withTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
