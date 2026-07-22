/**
 * Writes for Cinderella's OWN messages (CCB-S3-007).
 *
 * Kept apart from `upsertMessage` on purpose. That function is the member-capture
 * write path, and it never sets `is_bot`; if the two shared one function, a change
 * to the member path could start marking member messages as hers, or an
 * ON CONFLICT update could blank a category and quietly unpublish her side of a
 * conversation. Two call sites, two functions, no shared mutation.
 *
 * Nothing here touches the `consent` table. Her publication is decided by the
 * operator's `archive` settings through the SQL views; consent stays what it was.
 */

import type { Queryable } from './pool.js';
import { escapeRegex } from '../archive/redact.js';
import type { ReplyCategory } from '../archive/settings.js';

/** A member named inside one of her messages. */
export interface BotMention {
  /**
   * The member the name refers to, or null when it could not be resolved — an
   * unidentifiable name is treated as NOT publishable, because there is no
   * consent to point at.
   */
  memberId: string | null;
  /** Exactly the text embedded in the message, so redaction can find it. */
  displayName: string;
}

export interface BotMessageRow {
  groupId: number;
  groupMsgId: number;
  sharedMsgId: string | null;
  /** The bot's own stable group-member id (never a sentinel string). */
  senderMemberId: string;
  senderDisplayName: string;
  /** ISO 8601 timestamp of the sent item. */
  sentAt: string;
  text: string;
  /** Null when no handler classified this reply — such a row never publishes. */
  category: ReplyCategory | null;
  /** The language she answered in, for the localised redaction placeholder. */
  lang: string;
  /**
   * The text as it should be INDEXED: every named member already replaced. Never
   * null for a bot row — it is the ONLY thing her messages are searched by, so a
   * null would silently make a reply unfindable (and migration 013 rejects it).
   */
  searchBody: string;
  mentions: readonly BotMention[];
  rawJson: unknown;
}

/**
 * Records one of her messages. Idempotent on (group_id, group_msg_id) like the
 * member path, so a retry cannot produce a duplicate; mentions are replaced
 * wholesale rather than appended, so a retry cannot accumulate them either.
 *
 * CALL THIS INSIDE A TRANSACTION (see {@link recordBotReply}). The message row
 * and its mention rows must land together: a row that exists with its mentions
 * missing is indistinguishable from a reply that named nobody, and under the
 * default `redact` guard it would publish the name in the clear. The failure
 * mode of a half-written pair is a breach, not a gap.
 */
export async function insertBotMessage(db: Queryable, row: BotMessageRow): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO messages
       (group_id, group_msg_id, shared_msg_id, sender_member_id, sender_display_name,
        sent_at, type, text_body, links_text, raw_json,
        is_bot, bot_category, bot_lang, search_body, mentions_scanned)
     VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, NULL, $8::jsonb, TRUE, $9, $10, $11, TRUE)
     ON CONFLICT (group_id, group_msg_id) DO NOTHING
     RETURNING id`,
    [
      row.groupId,
      row.groupMsgId,
      row.sharedMsgId,
      row.senderMemberId,
      row.senderDisplayName,
      row.sentAt,
      row.text,
      JSON.stringify(row.rawJson),
      row.category,
      row.lang,
      row.searchBody,
    ],
  );
  // DO NOTHING rather than DO UPDATE, deliberately: an UPDATE here could set
  // `is_bot` on a row that is already in the table, and `is_bot` is what makes
  // the derivation skip the consent check entirely. Nothing should be able to
  // turn a member's message into one of hers. A conflict therefore means the send
  // was already recorded, and the existing row — with its existing mentions — is
  // left exactly as it is.
  const first = rows[0];
  if (!first) {
    const { rows: existing } = await db.query<{ id: string }>(
      'SELECT id FROM messages WHERE group_id = $1 AND group_msg_id = $2',
      [row.groupId, row.groupMsgId],
    );
    const id = existing[0]?.id;
    if (id === undefined) throw new Error('insertBotMessage: no id returned');
    return Number(id);
  }
  const id = Number(first.id);

  for (const m of row.mentions) {
    if (!m.displayName) continue; // an empty name is not a mention (and would break redaction)
    await db.query(
      `INSERT INTO message_mentions (message_id, member_id, display_name, display_pattern)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [id, m.memberId, m.displayName, escapeRegex(m.displayName)],
    );
  }
  return id;
}

/**
 * Resolves a display name typed by a member to the member id behind it, using the
 * archive's own record of who has posted under that name.
 *
 * Returns null when the name matches nobody OR more than one member. Both are
 * deliberate: the caller treats an unresolved mention as non-publishable, so an
 * ambiguous name is redacted rather than gambled on. A wrong resolution would
 * publish one member's name on the strength of another member's consent.
 */
export async function resolveMemberByDisplayName(
  db: Queryable,
  displayName: string,
): Promise<string | null> {
  const name = displayName.trim();
  if (!name) return null;
  const { rows } = await db.query<{ sender_member_id: string }>(
    `SELECT DISTINCT sender_member_id
       FROM messages
      WHERE is_bot = FALSE AND lower(sender_display_name) = lower($1)
      LIMIT 2`,
    [name],
  );
  return rows.length === 1 ? (rows[0]?.sender_member_id ?? null) : null;
}
