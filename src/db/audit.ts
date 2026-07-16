/**
 * `audit_log` — every state-changing admin action is recorded (who/what/when),
 * per A3 §5.
 */

import type { Queryable } from './pool.js';

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  details: unknown;
}

export async function writeAudit(
  db: Queryable,
  actor: string,
  action: string,
  target: string | null,
  details: unknown = null,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, action, target, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [actor, action, target, details === null ? null : JSON.stringify(details)],
  );
}

export async function recentAudit(db: Queryable, limit = 50): Promise<AuditEntry[]> {
  const { rows } = await db.query<{
    id: string;
    at: string;
    actor: string;
    action: string;
    target: string | null;
    details: unknown;
  }>(
    `SELECT id, at, actor, action, target, details
     FROM audit_log ORDER BY at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
