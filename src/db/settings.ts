/**
 * `settings` table — live-editable operator settings (A3). Boot/secret settings
 * (DB connection, credentials, session secret) are environment-only and never
 * stored here.
 */

import type { Queryable } from './pool.js';

export async function getSetting(db: Queryable, key: string): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    key,
  ]);
  return rows[0]?.value;
}

export async function getAllSettings(db: Queryable): Promise<Map<string, unknown>> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM settings',
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
