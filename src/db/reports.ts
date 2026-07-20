/**
 * Content-report data layer (CCB-S2-009). A report is a legal-notice signal, never
 * a moderation action — it writes ONLY this table and never changes a message's
 * publication state (visible-until-review). Stores the minimum: which published
 * item, why, when, and a non-identifying per-item-per-day anti-abuse token.
 */

import { createHmac } from 'node:crypto';
import type { Queryable } from './pool.js';

export const REPORT_REASONS = ['illegal', 'spam', 'copyright', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatusFilter = 'open' | 'resolved' | 'dismissed' | 'all';

/**
 * The ONLY reporter-derived value stored: HMAC-SHA256(secret, `ip|messageId|utcDate`).
 * Keyed (not reversible to an IP without the secret); the message id inside prevents
 * cross-archive reporter profiling; the UTC-date bucket rotates the token daily, so
 * dedup is per-item-per-client-per-day. Never store the raw IP.
 */
export function reporterHash(
  secret: string,
  ip: string,
  messageId: number,
  utcDate: string,
): string {
  return createHmac('sha256', secret).update(`${ip}|${messageId}|${utcDate}`).digest('hex');
}

/**
 * Inserts a report, absorbing a repeat from the same client+item+day via the
 * `reports_dedup` unique constraint (DB-level debounce). Returns true iff a NEW row
 * landed — but the caller returns an identical response either way (no probing).
 */
export async function createReport(
  db: Queryable,
  r: { messageId: number; reason: ReportReason; note: string | null; reporterHash: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO reports (message_id, reason, note, reporter_hash)
     VALUES ($1, $2::report_reason, $3, $4)
     ON CONFLICT (message_id, reporter_hash) DO NOTHING`,
    [r.messageId, r.reason, r.note, r.reporterHash],
  );
  return (rowCount ?? 0) > 0;
}

/** Distinct messages with an open report — the notification-bar count / queue length. */
export async function countOpenReports(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT message_id) AS n FROM reports WHERE status = 'open'`,
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ReportGroup {
  messageId: number;
  /** Number of report rows = distinct (client, day) signals — `UNIQUE(message_id,
   * reporter_hash)` makes count(*) and count(DISTINCT reporter_hash) identical, so we
   * expose one honest figure rather than two equal ones. */
  reportCount: number;
  reasons: string[];
  latestNote: string | null;
  firstAt: string;
  lastAt: string;
}

interface ReportGroupRow {
  message_id: string;
  report_count: number;
  reasons: unknown;
  latest_note: string | null;
  first_at: string;
  last_at: string;
}

/** One queue row per reported message, newest activity first. Filter by status. */
export async function listReportGroups(
  db: Queryable,
  filter: ReportStatusFilter,
): Promise<ReportGroup[]> {
  const where = filter === 'all' ? '' : 'WHERE r.status = $1::report_status';
  const params = filter === 'all' ? [] : [filter];
  const { rows } = await db.query<ReportGroupRow>(
    `SELECT r.message_id,
            count(*)::int AS report_count,
            array_agg(DISTINCT r.reason::text) AS reasons,
            (array_agg(r.note ORDER BY r.created_at DESC)
               FILTER (WHERE r.note IS NOT NULL))[1] AS latest_note,
            min(r.created_at) AS first_at,
            max(r.created_at) AS last_at
     FROM reports r
     ${where}
     GROUP BY r.message_id
     ORDER BY max(r.created_at) DESC`,
    params,
  );
  return rows.map((r) => ({
    messageId: Number(r.message_id),
    reportCount: Number(r.report_count),
    reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
    latestNote: r.latest_note,
    firstAt: new Date(r.first_at).toISOString(),
    lastAt: new Date(r.last_at).toISOString(),
  }));
}

/**
 * Marks a message's OPEN reports resolved/dismissed (the operator handled them).
 * Returns the number transitioned. Publication state is untouched here.
 */
export async function setReportsStatusForMessage(
  db: Queryable,
  messageId: number,
  status: 'resolved' | 'dismissed',
  handledBy: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE reports
     SET status = $2::report_status, handled_at = now(), handled_by = $3
     WHERE message_id = $1 AND status = 'open'`,
    [messageId, status, handledBy],
  );
  return rowCount ?? 0;
}
