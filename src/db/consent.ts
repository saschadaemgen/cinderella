/**
 * Consent table operations. Consent binds to the STABLE group member id, never
 * the display name (briefing §9). All functions take a `Queryable`.
 */

import type { Queryable } from './pool.js';

export interface ConsentRecord {
  memberId: string;
  optedInAt: string;
  revokedAt: string | null;
}

/**
 * Records opt-in for a member. Idempotent: a repeat /publish (or a re-opt-in
 * after revocation) sets a fresh opt-in timestamp and clears any revocation, so
 * publishing stays forward-only from the latest opt-in.
 *
 * @param at - the /publish command's group-message timestamp (ISO 8601).
 */
export async function recordOptIn(db: Queryable, memberId: string, at: string): Promise<void> {
  await db.query(
    `INSERT INTO consent (member_id, opted_in_at, revoked_at)
     VALUES ($1, $2, NULL)
     ON CONFLICT (member_id) DO UPDATE SET
       opted_in_at = EXCLUDED.opted_in_at,
       revoked_at  = NULL`,
    [memberId, at],
  );
}

/**
 * Records opt-out for a member. With the derived publish view, setting
 * `revoked_at` immediately removes all of that member's messages from the
 * published set. Returns true if an active consent row was revoked.
 */
export async function recordOptOut(db: Queryable, memberId: string, at: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE consent SET revoked_at = $2 WHERE member_id = $1 AND revoked_at IS NULL`,
    [memberId, at],
  );
  return (rowCount ?? 0) > 0;
}

export async function getConsent(db: Queryable, memberId: string): Promise<ConsentRecord | null> {
  const { rows } = await db.query<{
    member_id: string;
    opted_in_at: string;
    revoked_at: string | null;
  }>(`SELECT member_id, opted_in_at, revoked_at FROM consent WHERE member_id = $1`, [memberId]);
  const r = rows[0];
  if (!r) return null;
  return { memberId: r.member_id, optedInAt: r.opted_in_at, revokedAt: r.revoked_at };
}
