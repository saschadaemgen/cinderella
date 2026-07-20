/**
 * Public archive data layer (CCB-S2-003) — consent-gated, read-only.
 *
 * SECURITY INVARIANT: every read here goes through the `published_messages` view,
 * which is the consent-first projection (opted-in sender, forward-only from
 * opt-in, not deleted, not group-deleted, not moderation-rejected). Nothing that
 * is not published is ever returned — including a message's media reference. The
 * public routes MUST resolve media through {@link getPublishedMedia}, never by raw
 * path, so an unpublished / re-unpublished / deleted item's media 404s.
 *
 * This is the DATA layer only; presentation (theme/HTML/SEO) lives in
 * `src/web/public/render.ts`, so later briefings (templates CCB-S2-005, design
 * editor CCB-S2-006) change rendering without touching consent logic.
 */

import type { Queryable } from './pool.js';

/** Message types the archive understands (matches the `message_type` enum). */
export const ARCHIVE_TYPES = ['text', 'image', 'video', 'voice', 'link', 'file'] as const;
export type ArchiveType = (typeof ARCHIVE_TYPES)[number];

export interface PublicFilters {
  /** Visitor media-type filter; must be one of ARCHIVE_TYPES or undefined. */
  type?: ArchiveType;
  /** Inclusive lower bound on sent_at, interpreted as UTC (YYYY-MM-DD[THH:MM]). */
  since?: string;
  /** Inclusive upper bound on sent_at, interpreted as UTC. */
  until?: string;
  /** Full-text query (Postgres websearch syntax over the generated tsvector). */
  q?: string;
  page: number;
  pageSize: number;
}

export interface PublicLink {
  url: string;
  title: string | null;
}

export interface PublicItem {
  id: number;
  senderDisplayName: string;
  /** ISO 8601 UTC. */
  sentAt: string;
  type: ArchiveType;
  textBody: string | null;
  links: PublicLink[];
  /** True when a downloadable/renderable media file is attached AND published. */
  hasMedia: boolean;
  mediaMime: string | null;
}

export interface PublicPage {
  items: PublicItem[];
  total: number;
}

interface ItemRow {
  id: string;
  sender_display_name: string;
  sent_at: string;
  type: string;
  text_body: string | null;
  has_media: boolean;
  media_mime: string | null;
  links: unknown;
}

function toLinks(v: unknown): PublicLink[] {
  if (!Array.isArray(v)) return [];
  const out: PublicLink[] = [];
  for (const raw of v) {
    if (raw && typeof raw === 'object' && typeof (raw as { url?: unknown }).url === 'string') {
      const r = raw as { url: string; title?: unknown };
      out.push({ url: r.url, title: typeof r.title === 'string' ? r.title : null });
    }
  }
  return out;
}

/**
 * Lists published items for the public front, newest first, applying the
 * instance's enabled media types plus the visitor's URL-driven filters. All
 * filtering runs in SQL (server-side, crawlable) against `published_messages`.
 */
export async function listPublishedItems(
  db: Queryable,
  enabledTypes: readonly ArchiveType[],
  f: PublicFilters,
): Promise<PublicPage> {
  // No enabled types → nothing is shown (and no query needed).
  if (enabledTypes.length === 0) return { items: [], total: 0 };

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  // Instance media visibility (always applied) — never show a disabled type.
  // enabledTypes is a subset of the fixed ARCHIVE_TYPES whitelist (never user
  // input), so the IN-list is safe to inline; keeps the query param-array-free.
  where.push(`m.type IN (${enabledTypes.map((t) => `'${t}'`).join(', ')})`);
  // Visitor type filter (must itself be an enabled type; the caller validates).
  if (f.type) add('m.type = ?::message_type', f.type);
  // Time window — interpret the naive datetime-local input as UTC explicitly.
  if (f.since) add("m.sent_at >= (?::timestamp AT TIME ZONE 'UTC')", f.since);
  if (f.until) add("m.sent_at <= (?::timestamp AT TIME ZONE 'UTC')", f.until);
  // Full-text search over the generated 'simple' tsvector (matches migration 001).
  if (f.q) add("m.search @@ websearch_to_tsquery('simple', ?)", f.q);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const countRes = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM published_messages m ${whereSql}`,
    params,
  );

  const offset = Math.min((f.page - 1) * f.pageSize, Number.MAX_SAFE_INTEGER);
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const rows = await db.query<ItemRow>(
    `SELECT m.id, m.sender_display_name, m.sent_at, m.type::text AS type, m.text_body,
            (m.media_path IS NOT NULL) AS has_media, m.media_mime,
            COALESCE(
              (SELECT json_agg(json_build_object('url', l.url, 'title', l.title) ORDER BY l.id)
               FROM links l WHERE l.message_id = m.id),
              '[]'::json
            ) AS links
     FROM published_messages m
     ${whereSql}
     ORDER BY m.sent_at DESC, m.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, f.pageSize, offset],
  );

  return {
    total: Number(countRes.rows[0]?.n ?? 0),
    items: rows.rows.map((r) => ({
      id: Number(r.id),
      senderDisplayName: r.sender_display_name,
      // TIMESTAMPTZ comes back as a Date (pg/PGlite) — normalize to an ISO string
      // so it renders and serializes (JSON-LD) deterministically.
      sentAt: new Date(r.sent_at).toISOString(),
      type: r.type as ArchiveType,
      textBody: r.text_body,
      links: toLinks(r.links),
      hasMedia: r.has_media,
      mediaMime: r.media_mime,
    })),
  };
}

export interface PublishedMedia {
  mediaPath: string;
  mediaMime: string | null;
  type: ArchiveType;
}

/**
 * Resolves a message's media ONLY if that message is currently published.
 * Returns null when the message is not published, does not exist, or has no
 * media — the consent gate for the public media route. Never returns a raw path
 * for an unpublished item.
 */
export async function getPublishedMedia(
  db: Queryable,
  messageId: number,
): Promise<PublishedMedia | null> {
  const { rows } = await db.query<{
    media_path: string | null;
    media_mime: string | null;
    type: string;
  }>(
    `SELECT media_path, media_mime, type::text AS type
     FROM published_messages
     WHERE id = $1`,
    [messageId],
  );
  const r = rows[0];
  if (!r || !r.media_path) return null;
  return { mediaPath: r.media_path, mediaMime: r.media_mime, type: r.type as ArchiveType };
}

/** The most recent published image, for OG/Twitter/`ItemList` preview imagery. */
export async function latestPublishedImageId(
  db: Queryable,
  enabledTypes: readonly ArchiveType[],
): Promise<number | null> {
  if (!enabledTypes.includes('image')) return null;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM published_messages
     WHERE type = 'image'::message_type AND media_path IS NOT NULL
     ORDER BY sent_at DESC, id DESC
     LIMIT 1`,
  );
  return rows[0] ? Number(rows[0].id) : null;
}
