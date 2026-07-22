/**
 * The consent action journal (CCB-S3-002) and the undo it exists to support.
 *
 * `consent` says what a member's decision IS. This module records how each
 * decision was reached and what it replaced, which is the only way to put a
 * decision back the way it was: an opt-in that created the first consent row and
 * an opt-in that replaced a revoked one leave identical current state, but
 * undoing them must do different things.
 *
 * Publication is still derived from `consent` alone — nothing here is consulted
 * by `message_publish_state`. This is provenance, not a second source of truth.
 */

import type { Queryable } from './pool.js';

export type ConsentAction = 'opt_in' | 'opt_out';
/** How the decision reached us. `natural` is the wake-word path (CCB-S3-002). */
export type ConsentSource = 'slash' | 'natural' | 'admin';

export interface ConsentActionRow {
  id: number;
  memberId: string;
  action: ConsentAction;
  source: ConsentSource;
  at: string;
  prevExisted: boolean;
  prevOptedInAt: string | null;
  prevRevokedAt: string | null;
  undoneAt: string | null;
}

interface RawRow {
  id: string;
  member_id: string;
  action: string;
  source: string;
  at: string;
  prev_existed: boolean;
  prev_opted_in_at: string | null;
  prev_revoked_at: string | null;
  undone_at: string | null;
}

function mapRow(r: RawRow): ConsentActionRow {
  return {
    id: Number(r.id),
    memberId: r.member_id,
    action: r.action as ConsentAction,
    source: r.source as ConsentSource,
    at: r.at,
    prevExisted: r.prev_existed,
    prevOptedInAt: r.prev_opted_in_at,
    prevRevokedAt: r.prev_revoked_at,
    undoneAt: r.undone_at,
  };
}

export interface PriorConsentState {
  existed: boolean;
  optedInAt: string | null;
  revokedAt: string | null;
}

/** Reads the consent row as it stands right now, for journalling as "previous". */
export async function readConsentState(
  db: Queryable,
  memberId: string,
): Promise<PriorConsentState> {
  const { rows } = await db.query<{ opted_in_at: string; revoked_at: string | null }>(
    'SELECT opted_in_at, revoked_at FROM consent WHERE member_id = $1',
    [memberId],
  );
  const r = rows[0];
  if (!r) return { existed: false, optedInAt: null, revokedAt: null };
  return { existed: true, optedInAt: r.opted_in_at, revokedAt: r.revoked_at };
}

/** Appends one decision to the journal. */
export async function journalConsentAction(
  db: Queryable,
  entry: {
    memberId: string;
    action: ConsentAction;
    source: ConsentSource;
    at: string;
    prior: PriorConsentState;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO consent_actions
       (member_id, action, source, at, prev_existed, prev_opted_in_at, prev_revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.memberId,
      entry.action,
      entry.source,
      entry.at,
      entry.prior.existed,
      entry.prior.optedInAt,
      entry.prior.revokedAt,
    ],
  );
}

/**
 * The member's most recent decision that has not already been reverted, or null.
 * `notBefore` bounds it to the undo window; pass null for no bound.
 */
export async function lastUndoableAction(
  db: Queryable,
  memberId: string,
  notBefore: string | null,
): Promise<ConsentActionRow | null> {
  const { rows } = await db.query<RawRow>(
    `SELECT id, member_id, action, source, at, prev_existed, prev_opted_in_at,
            prev_revoked_at, undone_at
     FROM consent_actions
     WHERE member_id = $1
       AND undone_at IS NULL
       AND ($2::timestamptz IS NULL OR at >= $2::timestamptz)
     ORDER BY at DESC, id DESC
     LIMIT 1`,
    [memberId, notBefore],
  );
  const r = rows[0];
  return r ? mapRow(r) : null;
}

/**
 * Reverts a member's own last consent decision, restoring the exact prior state,
 * and marks the journal row as undone so it cannot be reverted twice.
 *
 * Scoped to ONE member on purpose (§4.4): the caller passes the requester's own
 * member id, so there is no shape of this call that can undo somebody else's
 * decision. Returns the action that was reverted, or null when there was nothing
 * to revert inside the window.
 */
export async function undoLastConsentAction(
  db: Queryable,
  memberId: string,
  at: string,
  notBefore: string | null,
): Promise<ConsentActionRow | null> {
  const action = await lastUndoableAction(db, memberId, notBefore);
  if (!action) return null;

  if (action.prevExisted) {
    await db.query(`UPDATE consent SET opted_in_at = $2, revoked_at = $3 WHERE member_id = $1`, [
      memberId,
      action.prevOptedInAt,
      action.prevRevokedAt,
    ]);
  } else {
    // There was no consent row before this action, so putting things back means
    // there is no consent row now either.
    await db.query('DELETE FROM consent WHERE member_id = $1', [memberId]);
  }

  await db.query('UPDATE consent_actions SET undone_at = $2 WHERE id = $1', [action.id, at]);
  return action;
}

/** Recent journal entries for a member (admin/debug reads). */
export async function memberConsentHistory(
  db: Queryable,
  memberId: string,
  limit = 20,
): Promise<ConsentActionRow[]> {
  const { rows } = await db.query<RawRow>(
    `SELECT id, member_id, action, source, at, prev_existed, prev_opted_in_at,
            prev_revoked_at, undone_at
     FROM consent_actions
     WHERE member_id = $1
     ORDER BY at DESC, id DESC
     LIMIT $2`,
    [memberId, limit],
  );
  return rows.map(mapRow);
}
