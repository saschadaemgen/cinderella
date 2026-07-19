/**
 * Read queries backing the admin console views (dashboard, messages browser,
 * consent viewer). Read-only — all writes go through the dedicated modules.
 */

import type { Queryable } from './pool.js';

export interface DashboardStats {
  totalMessages: number;
  publishedMessages: number;
  deletedMessages: number;
  byType: { type: string; count: number }[];
  consentActive: number;
  consentRevoked: number;
  lastSentAt: string | null;
  /** Media expected but missing: pending (younger than threshold) vs at risk. */
  mediaPending: number;
  mediaAtRisk: number;
  mediaFailed: number;
}

export async function dashboardStats(db: Queryable, alertHours: number): Promise<DashboardStats> {
  const [totals, byType, consent, media] = await Promise.all([
    db.query<{ total: string; published: string; deleted: string; last_sent: string | null }>(
      `SELECT
         (SELECT count(*) FROM messages)                                 AS total,
         (SELECT count(*) FROM published_messages)                       AS published,
         (SELECT count(*) FROM messages WHERE deleted OR group_deleted)  AS deleted,
         (SELECT max(sent_at) FROM messages)                             AS last_sent`,
    ),
    db.query<{ type: string; count: string }>(
      `SELECT type::text AS type, count(*) AS count FROM messages GROUP BY type ORDER BY count DESC`,
    ),
    db.query<{ active: string; revoked: string }>(
      `SELECT
         count(*) FILTER (WHERE revoked_at IS NULL)     AS active,
         count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
       FROM consent`,
    ),
    db.query<{ pending: string; at_risk: string; failed: string }>(
      `SELECT
         count(*) FILTER (WHERE media_error IS NULL
                          AND sent_at >  now() - ($1 || ' hours')::interval) AS pending,
         count(*) FILTER (WHERE media_error IS NULL
                          AND sent_at <= now() - ($1 || ' hours')::interval) AS at_risk,
         count(*) FILTER (WHERE media_error IS NOT NULL)                     AS failed
       FROM messages
       WHERE type IN ('image', 'video', 'voice', 'file')
         AND media_path IS NULL
         AND deleted = FALSE`,
      [String(alertHours)],
    ),
  ]);

  const t = totals.rows[0];
  const c = consent.rows[0];
  const m = media.rows[0];
  return {
    totalMessages: Number(t?.total ?? 0),
    publishedMessages: Number(t?.published ?? 0),
    deletedMessages: Number(t?.deleted ?? 0),
    byType: byType.rows.map((r) => ({ type: r.type, count: Number(r.count) })),
    consentActive: Number(c?.active ?? 0),
    consentRevoked: Number(c?.revoked ?? 0),
    lastSentAt: t?.last_sent ?? null,
    mediaPending: Number(m?.pending ?? 0),
    mediaAtRisk: Number(m?.at_risk ?? 0),
    mediaFailed: Number(m?.failed ?? 0),
  };
}

export interface MessageFilters {
  type?: string;
  published?: 'yes' | 'no';
  deleted?: 'yes' | 'no';
  since?: string;
  until?: string;
  page: number;
  pageSize: number;
}

export interface AdminMessage {
  id: number;
  groupId: number;
  groupMsgId: number;
  senderMemberId: string;
  senderDisplayName: string;
  sentAt: string;
  type: string;
  textBody: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaError: string | null;
  deleted: boolean;
  /** Set by an in-group deletion event; never clearable from the admin console. */
  groupDeleted: boolean;
  moderationState: string;
  published: boolean;
  /** Sender has a consent row (opted in at some point). */
  hasConsent: boolean;
  /** That consent row is currently revoked (/unpublish). */
  consentRevoked: boolean;
  /** Consented + not revoked, but this message predates the opt-in (forward-only). */
  beforeOptIn: boolean;
}

const VALID_TYPES = new Set(['text', 'image', 'video', 'voice', 'link', 'file']);

/**
 * Human-readable reasons a message is NOT on the public archive, mirroring the
 * `message_publish_state` derivation for display. Empty when the message is
 * published. Lets the console explain why moderation actions don't change the
 * published state (e.g. the sender never opted in), instead of looking inert.
 */
export function publishReasons(m: AdminMessage): string[] {
  if (m.published) return [];
  const reasons: string[] = [];
  if (m.groupDeleted) reasons.push('removed in group');
  if (m.deleted) reasons.push('deleted by admin');
  if (m.moderationState === 'rejected') reasons.push('unpublished by admin');
  if (!m.hasConsent) reasons.push('no member consent');
  else if (m.consentRevoked) reasons.push('member opted out');
  else if (m.beforeOptIn) reasons.push('sent before opt-in');
  if (reasons.length === 0) reasons.push('not published');
  return reasons;
}

export async function browseMessages(
  db: Queryable,
  f: MessageFilters,
): Promise<{ messages: AdminMessage[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (f.type && VALID_TYPES.has(f.type)) add('m.type = ?::message_type', f.type);
  if (f.published === 'yes') add('s.published = ?', true);
  if (f.published === 'no') add('s.published = ?', false);
  // "deleted" in the UI means removed by anyone (admin or in-group).
  if (f.deleted === 'yes') add('(m.deleted OR m.group_deleted) = ?', true);
  if (f.deleted === 'no') add('(m.deleted OR m.group_deleted) = ?', false);
  // The datetime-local inputs are timezone-naive and the UI shows UTC, so
  // interpret them explicitly as UTC (not the DB session timezone).
  if (f.since) add("m.sent_at >= (?::timestamp AT TIME ZONE 'UTC')", f.since);
  if (f.until) add("m.sent_at <= (?::timestamp AT TIME ZONE 'UTC')", f.until);

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const baseSql = `
    FROM messages m
    JOIN message_publish_state s ON s.id = m.id
    LEFT JOIN consent c ON c.member_id = m.sender_member_id
    ${whereSql}`;

  const countRes = await db.query<{ n: string }>(`SELECT count(*) AS n ${baseSql}`, params);

  // LIMIT/OFFSET as bind parameters, with the offset clamped to a safe integer
  // so an oversized ?page can't build an out-of-range bigint literal that 500s.
  const offset = Math.min((f.page - 1) * f.pageSize, Number.MAX_SAFE_INTEGER);
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const rows = await db.query<{
    id: string;
    group_id: string;
    group_msg_id: string;
    sender_member_id: string;
    sender_display_name: string;
    sent_at: string;
    type: string;
    text_body: string | null;
    media_path: string | null;
    media_mime: string | null;
    media_error: string | null;
    deleted: boolean;
    group_deleted: boolean;
    moderation_state: string;
    published: boolean;
    has_consent: boolean;
    consent_revoked: boolean;
    before_opt_in: boolean;
  }>(
    `SELECT m.id, m.group_id, m.group_msg_id, m.sender_member_id, m.sender_display_name,
            m.sent_at, m.type::text AS type, m.text_body, m.media_path, m.media_mime,
            m.media_error, m.deleted, m.group_deleted,
            m.moderation_state::text AS moderation_state, s.published,
            (c.member_id IS NOT NULL) AS has_consent,
            (c.revoked_at IS NOT NULL) AS consent_revoked,
            (c.member_id IS NOT NULL AND c.revoked_at IS NULL AND m.sent_at < c.opted_in_at)
              AS before_opt_in
     ${baseSql}
     ORDER BY m.sent_at DESC, m.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, f.pageSize, offset],
  );

  return {
    total: Number(countRes.rows[0]?.n ?? 0),
    messages: rows.rows.map((r) => ({
      id: Number(r.id),
      groupId: Number(r.group_id),
      groupMsgId: Number(r.group_msg_id),
      senderMemberId: r.sender_member_id,
      senderDisplayName: r.sender_display_name,
      sentAt: r.sent_at,
      type: r.type,
      textBody: r.text_body,
      mediaPath: r.media_path,
      mediaMime: r.media_mime,
      mediaError: r.media_error,
      deleted: r.deleted,
      groupDeleted: r.group_deleted,
      moderationState: r.moderation_state,
      published: r.published,
      hasConsent: r.has_consent,
      consentRevoked: r.consent_revoked,
      beforeOptIn: r.before_opt_in,
    })),
  };
}

export async function getAdminMessage(db: Queryable, id: number): Promise<AdminMessage | null> {
  const { messages } = await browseMessagesById(db, id);
  return messages[0] ?? null;
}

async function browseMessagesById(
  db: Queryable,
  id: number,
): Promise<{ messages: AdminMessage[] }> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT m.id, m.group_id, m.group_msg_id, m.sender_member_id, m.sender_display_name,
            m.sent_at, m.type::text AS type, m.text_body, m.media_path, m.media_mime,
            m.media_error, m.deleted, m.group_deleted,
            m.moderation_state::text AS moderation_state, s.published,
            (c.member_id IS NOT NULL) AS has_consent,
            (c.revoked_at IS NOT NULL) AS consent_revoked,
            (c.member_id IS NOT NULL AND c.revoked_at IS NULL AND m.sent_at < c.opted_in_at)
              AS before_opt_in
     FROM messages m
     JOIN message_publish_state s ON s.id = m.id
     LEFT JOIN consent c ON c.member_id = m.sender_member_id
     WHERE m.id = $1`,
    [id],
  );
  return {
    messages: rows.rows.map((r) => ({
      id: Number(r['id']),
      groupId: Number(r['group_id']),
      groupMsgId: Number(r['group_msg_id']),
      senderMemberId: String(r['sender_member_id']),
      senderDisplayName: String(r['sender_display_name']),
      sentAt: String(r['sent_at']),
      type: String(r['type']),
      textBody: (r['text_body'] as string | null) ?? null,
      mediaPath: (r['media_path'] as string | null) ?? null,
      mediaMime: (r['media_mime'] as string | null) ?? null,
      mediaError: (r['media_error'] as string | null) ?? null,
      deleted: Boolean(r['deleted']),
      groupDeleted: Boolean(r['group_deleted']),
      moderationState: String(r['moderation_state']),
      published: Boolean(r['published']),
      hasConsent: Boolean(r['has_consent']),
      consentRevoked: Boolean(r['consent_revoked']),
      beforeOptIn: Boolean(r['before_opt_in']),
    })),
  };
}

export interface ConsentView {
  memberId: string;
  optedInAt: string;
  revokedAt: string | null;
  messageCount: number;
  publishedCount: number;
}

export async function consentOverview(db: Queryable): Promise<ConsentView[]> {
  const { rows } = await db.query<{
    member_id: string;
    opted_in_at: string;
    revoked_at: string | null;
    message_count: string;
    published_count: string;
  }>(
    `SELECT c.member_id, c.opted_in_at, c.revoked_at,
            (SELECT count(*) FROM messages m WHERE m.sender_member_id = c.member_id)          AS message_count,
            (SELECT count(*) FROM published_messages p WHERE p.sender_member_id = c.member_id) AS published_count
     FROM consent c
     ORDER BY c.opted_in_at DESC`,
  );
  return rows.map((r) => ({
    memberId: r.member_id,
    optedInAt: r.opted_in_at,
    revokedAt: r.revoked_at,
    messageCount: Number(r.message_count),
    publishedCount: Number(r.published_count),
  }));
}
