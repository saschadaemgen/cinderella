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
 * Marks messages deleted (in-group deletion). Deleted messages are excluded from
 * the published set, mirroring SimpleX's own channel webpage (briefing §5/§10).
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
       SET deleted = TRUE
     WHERE group_id = $1 AND group_msg_id = ANY($2::bigint[])`,
    [groupId, [...groupMsgIds]],
  );
  return rowCount ?? 0;
}

/** Records the media path/mime/size once a file has been received and stored. */
export async function updateMedia(
  db: Queryable,
  groupId: number,
  groupMsgId: number,
  media: MediaInput,
): Promise<void> {
  await db.query(
    `UPDATE messages
       SET media_path = $3, media_mime = $4, media_size = $5
     WHERE group_id = $1 AND group_msg_id = $2`,
    [groupId, groupMsgId, media.mediaPath, media.mediaMime, media.mediaSize],
  );
}
