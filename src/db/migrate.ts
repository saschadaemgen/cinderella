/**
 * Minimal forward-only migration runner.
 *
 * Applies `migrations/NNN_*.sql` in filename order, each exactly once, inside a
 * transaction, recording applied names in `schema_migrations`.
 *
 *   npm run migrate
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';
import { log } from '../log.js';

export interface Migration {
  name: string;
  sql: string;
}

/** The migrations directory lives at the project root (sibling of src/ and dist/). */
function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

/** Loads all migration files sorted by name. Shared by the runner and tests. */
export async function loadMigrationFiles(): Promise<Migration[]> {
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const name of files) {
    migrations.push({ name, sql: await readFile(join(dir, name), 'utf8') });
  }
  return migrations;
}

/**
 * Applies any not-yet-applied migrations against the pool. Returns the names of
 * the migrations that were applied in this run.
 */
export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const migration of await loadMigrationFiles()) {
      if (done.has(migration.name)) continue;
      log.info(`Applying migration ${migration.name}…`);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

/** CLI entry: `npm run migrate`. */
async function main(): Promise<void> {
  const applied = await runMigrations();
  if (applied.length === 0) {
    log.info('No pending migrations — database is up to date.');
  } else {
    log.info(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
}

// Run only when invoked directly (not when imported).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      void closePool().finally(() => process.exit(1));
    });
}
