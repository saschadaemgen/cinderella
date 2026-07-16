/**
 * Write operations for the `messages` and `links` tables. All functions take a
 * `Queryable` so they run against the pool, a transaction client, or a test
 * engine interchangeably.
 */

import type { Queryable } from './pool.js';
import type { CapturedType } from '../capture/message.js';

export interface MessageRow {
  groupId: number;
  groupMsgId: number;
  sharedMsgId: string | null;
  senderMemberId: string;
  senderDisplayName: string;
  /** ISO 8601 timestamp. */
  sentAt: string;
  type: CapturedType;
  textBody: string | null;
  linksText: string | null;
  rawJson: unknown;
}

export interface LinkInput {
  url: string;
  title: string | null;
  description: string | null;
}

export interface MediaInput {
  mediaPath: string;
  mediaMime: string;
  mediaSize: number;
}

/**
 * Inserts (or updates on re-delivery) a captured message. Idempotent on
 * (group_id, group_msg_id). Returns the message row id.
 *
 * Media columns are intentionally left untouched here — the file is downloaded
 * asynchronously and set later via {@link updateMedia}.
 */
export async function upsertMessage(db: Queryable, row: MessageRow): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO messages
       (group_id, group_msg_id, shared_msg_id, sender_member_id, sender_display_name,
        sent_at, type, text_body, links_text, raw_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (group_id, group_msg_id) DO UPDATE SET
       shared_msg_id       = EXCLUDED.shared_msg_id,
       sender_member_id    = EXCLUDED.sender_member_id,
       sender_display_name = EXCLUDED.sender_display_name,
       sent_at             = EXCLUDED.sent_at,
       type                = EXCLUDED.type,
       text_body           = EXCLUDED.text_body,
       links_text          = EXCLUDED.links_text,
       raw_json            = EXCLUDED.raw_json
     RETURNING id`,
    [
      row.groupId,
      row.groupMsgId,
      row.sharedMsgId,
      row.senderMemberId,
      row.senderDisplayName,
      row.sentAt,
      row.type,
      row.textBody,
      row.linksText,
      JSON.stringify(row.rawJson),
    ],
  );
  const first = rows[0];
  if (!first) throw new Error('upsertMessage: no id returned');
  return Number(first.id);
}

/** Replaces the links for a message (delete-then-insert). */
export async function replaceLinks(
  db: Queryable,
  messageId: number,
  links: readonly LinkInput[],
): Promise<void> {
  await db.query('DELETE FROM links WHERE message_id = $1', [messageId]);
  for (const link of links) {
    await db.query(
      `INSERT INTO links (message_id, url, title, preview_description)
       VALUES ($1, $2, $3, $4)`,
      [messageId, link.url, link.title, link.description],
    );
  }
}

/**
 * Marks messages deleted IN-GROUP (a SimpleX deletion event). Sets the
 * `group_deleted` flag, which the admin console can never clear — so a member's
 * in-group deletion can never be undone into publication (briefing §5/§10).
 * Idempotent. Returns the number of rows flipped.
 */
export async function markDeleted(
  db: Queryable,
  groupId: number,
  groupMsgIds: readonly number[],
): Promise<number> {
  if (groupMsgIds.length === 0) return 0;
  const { rowCount } = await db.query(
    `UPDATE messages
       SET group_deleted = TRUE
     WHERE group_id = $1 AND group_msg_id = ANY($2::bigint[])`,
    [groupId, [...groupMsgIds]],
  );
  return rowCount ?? 0;
}

/**
 * Records the media path/mime/size once a file has been received and stored.
 * Returns the number of rows updated (0 => the message row is missing, i.e. the
 * stored media would be orphaned).
 */
export async function updateMedia(
  db: Queryable,
  groupId: number,
  groupMsgId: number,
  media: MediaInput,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE messages
       SET media_path = $3, media_mime = $4, media_size = $5, media_error = NULL
     WHERE group_id = $1 AND group_msg_id = $2`,
    [groupId, groupMsgId, media.mediaPath, media.mediaMime, media.mediaSize],
  );
  return rowCount ?? 0;
}

/**
 * On startup, flags media-type messages whose file was never received (no path,
 * no recorded error) as interrupted, so the dashboard surfaces them. Any receipt
 * in-flight when the process last stopped is gone; XFTP relays may still have the
 * file (~48h), but the operator needs to know it wasn't captured. Returns the
 * number of rows flagged.
 */
export async function markInterruptedMediaReceipts(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE messages
       SET media_error = 'receipt interrupted (process restart) — not captured'
     WHERE type IN ('image', 'video', 'voice', 'file')
       AND media_path IS NULL
       AND media_error IS NULL
       AND deleted = FALSE
       AND group_deleted = FALSE`,
  );
  return rowCount ?? 0;
}

/** Records a failed file receipt so the dashboard can surface it (§10.2). */
export async function recordMediaError(
  db: Queryable,
  groupId: number,
  groupMsgId: number,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE messages SET media_error = $3
     WHERE group_id = $1 AND group_msg_id = $2 AND media_path IS NULL`,
    [groupId, groupMsgId, error.slice(0, 500)],
  );
}

export type ModerationState = 'none' | 'pending' | 'approved' | 'rejected';

/**
 * Manual moderation (admin takedown/restore). 'rejected' removes the message
 * from the published set via the publish views. Returns true if a row changed.
 */
export async function setModerationState(
  db: Queryable,
  messageId: number,
  state: ModerationState,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE messages SET moderation_state = $2::moderation_state WHERE id = $1`,
    [messageId, state],
  );
  return (rowCount ?? 0) > 0;
}

/** Admin "mark deleted" by message row id. Returns true if a row changed. */
export async function setDeletedById(
  db: Queryable,
  messageId: number,
  deleted: boolean,
): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE messages SET deleted = $2 WHERE id = $1`, [
    messageId,
    deleted,
  ]);
  return (rowCount ?? 0) > 0;
}
