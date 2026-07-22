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

import { createHash } from 'node:crypto';
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
  /** Opaque pagination cursor for this row — its exact `(sent_at, id)` sort key
   * (CCB-S2-007). SSR emits it as `data-cursor`; the client pages from it. */
  cursor: string;
  type: ArchiveType;
  textBody: string | null;
  links: PublicLink[];
  /** True when a downloadable/renderable media file is attached AND published. */
  hasMedia: boolean;
  mediaMime: string | null;
  /**
   * True when Cinderella wrote this, rather than a member (CCB-S3-007). The
   * public front marks her cards so a reader can tell whose voice they are
   * reading; it is presentation only — publication was already decided by the
   * view this row came out of.
   */
  isBot: boolean;
  /** The id of the message this one answers, when it is one (CCB-S3-009). */
  replyToId: number | null;
}

export interface PublicPage {
  items: PublicItem[];
  total: number;
}

interface ItemRow {
  id: string;
  sender_display_name: string;
  sent_at: string;
  /** `sent_at::text` — full microsecond precision for the cursor (never the ms ISO). */
  sort_ts: string;
  type: string;
  text_body: string | null;
  has_media: boolean;
  media_mime: string | null;
  is_bot: boolean;
  reply_to_id: string | null;
  links: unknown;
}

/** Decoded pagination cursor: the exact `(sent_at, id)` sort key of a boundary row. */
export interface Cursor {
  /** Full-precision `sent_at::text`, e.g. `2026-07-18 09:00:00.123456+00`. */
  sentAt: string;
  id: number;
}

export type CursorDir = 'older' | 'newer';

/** Strict shape of a `timestamptz::text` value (space-separated, offset suffix). */
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:?\d{2})?$/;

/** Encodes a row's sort key as an opaque base64url cursor (public data only). */
export function encodeCursor(sentAt: string, id: number): string {
  return Buffer.from(`${sentAt}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor with STRICT validation — malformed input returns null
 * (the route maps that to 400, never a silent page-1 that would dupe cards, and the
 * raw string is never fed to SQL). The cursor is a sort key, not a security boundary.
 */
export function decodeCursor(s: string): Cursor | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 256) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.lastIndexOf('|');
  if (i <= 0) return null;
  const sentAt = decoded.slice(0, i);
  const idStr = decoded.slice(i + 1);
  if (!/^\d{1,19}$/.test(idStr)) return null;
  const id = Number.parseInt(idStr, 10);
  if (!Number.isInteger(id) || id < 1) return null;
  if (!CURSOR_TS_RE.test(sentAt)) return null;
  return { sentAt, id };
}

/** Shared SELECT list for a public item row (includes the full-precision sort key). */
const ITEM_COLUMNS = `m.id, m.sender_display_name, m.sent_at, m.sent_at::text AS sort_ts,
            m.type::text AS type, m.text_body,
            (m.media_path IS NOT NULL) AS has_media, m.media_mime, m.is_bot, m.reply_to_id,
            COALESCE(
              (SELECT json_agg(json_build_object('url', l.url, 'title', l.title) ORDER BY l.id)
               FROM links l WHERE l.message_id = m.id),
              '[]'::json
            ) AS links`;

/** Maps a DB row to a PublicItem (TIMESTAMPTZ → ISO for display; sort_ts → cursor). */
function mapItem(r: ItemRow): PublicItem {
  return {
    id: Number(r.id),
    senderDisplayName: r.sender_display_name,
    // TIMESTAMPTZ comes back as a Date (pg/PGlite) — normalize to an ISO string
    // so it renders and serializes (JSON-LD) deterministically.
    sentAt: new Date(r.sent_at).toISOString(),
    cursor: encodeCursor(r.sort_ts, Number(r.id)),
    type: r.type as ArchiveType,
    textBody: r.text_body,
    links: toLinks(r.links),
    hasMedia: r.has_media,
    mediaMime: r.media_mime,
    isBot: r.is_bot === true,
    replyToId: r.reply_to_id === null ? null : Number(r.reply_to_id),
  };
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
 * Builds the shared consent-gated WHERE clause for `published_messages`: the
 * instance's enabled types (inlined whitelist) plus the visitor's validated
 * filters. Returned `params` are positional ($1…); a caller that appends its own
 * (LIMIT/OFFSET) starts numbering at `params.length + 1`.
 */
function buildPublishedWhere(
  enabledTypes: readonly ArchiveType[],
  f: Pick<PublicFilters, 'type' | 'since' | 'until' | 'q'>,
): { whereSql: string; params: unknown[] } {
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

  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
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

  const { whereSql, params } = buildPublishedWhere(enabledTypes, f);
  const countRes = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM published_messages m ${whereSql}`,
    params,
  );

  const offset = Math.min((f.page - 1) * f.pageSize, Number.MAX_SAFE_INTEGER);
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const rows = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}
     FROM published_messages m
     ${whereSql}
     ORDER BY m.sent_at DESC, m.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, f.pageSize, offset],
  );

  return {
    total: Number(countRes.rows[0]?.n ?? 0),
    items: rows.rows.map(mapItem),
  };
}

/** A cursor-paged slice of published items (CCB-S2-007). */
export interface CursorPage {
  items: PublicItem[];
  hasMore: boolean;
  /** Cursor to fetch the NEXT slice in the same direction; null when exhausted. */
  nextCursor: string | null;
}

/**
 * Cursor pagination over the published stream (CCB-S2-007) — stable across
 * publish/recall between loads (no offset drift). `older` pages down (DESC, strictly
 * older than the cursor); `newer` pages up (ASC then reversed to newest-first).
 * Reads ONLY `published_messages`; the cursor clause only NARROWS an already
 * consent-gated set, so it can never surface an unpublished/recalled id. Fetches
 * `step+1` to derive `hasMore` without a count query.
 */
export async function listPublishedItemsByCursor(
  db: Queryable,
  enabledTypes: readonly ArchiveType[],
  f: Pick<PublicFilters, 'type' | 'since' | 'until' | 'q'>,
  cursor: Cursor | null,
  dir: CursorDir,
  step: number,
): Promise<CursorPage> {
  if (enabledTypes.length === 0) return { items: [], hasMore: false, nextCursor: null };

  const { whereSql, params } = buildPublishedWhere(enabledTypes, f);
  let cursorClause = '';
  if (cursor) {
    const tsP = `$${params.length + 1}`;
    const idP = `$${params.length + 2}`;
    params.push(cursor.sentAt, cursor.id);
    // Expanded-OR form (NOT a row-value constructor — PGlite-unreliable); each value
    // bound once with an explicit cast, mirroring the existing timestamp posture.
    const cmp = dir === 'older' ? '<' : '>';
    cursorClause =
      ` AND (m.sent_at ${cmp} ${tsP}::timestamptz` +
      ` OR (m.sent_at = ${tsP}::timestamptz AND m.id ${cmp} ${idP}::bigint))`;
  }
  const order = dir === 'older' ? 'DESC' : 'ASC';
  const limitP = `$${params.length + 1}`;
  const rows = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}
     FROM published_messages m
     ${whereSql}${cursorClause}
     ORDER BY m.sent_at ${order}, m.id ${order}
     LIMIT ${limitP}`,
    [...params, step + 1],
  );

  let items = rows.rows.map(mapItem);
  const hasMore = items.length > step;
  if (hasMore) items = items.slice(0, step);
  // `newer` fetched ascending (closest-to-cursor first) → flip to newest-first.
  if (dir === 'newer') items.reverse();
  const boundary = dir === 'older' ? items[items.length - 1] : items[0];
  return { items, hasMore, nextCursor: hasMore && boundary ? boundary.cursor : null };
}

/** Cheap consent-gated fingerprint of a view (CCB-S2-006 live poll). */
export interface PublishedState {
  /** Published item ids for the view, newest first (same window as the page). */
  ids: number[];
  /** Short version hash over the id list + per-item content marker + total. */
  hash: string;
  total: number;
}

interface StateRow {
  id: string;
  /** md5 over the published text + media path — changes on edit, never leaks. */
  marker: string;
}

/**
 * Version hash of a view: stable for an unchanged set, differs on add/remove/edit.
 * Hashes ONLY the ids + content markers of the given rows (NOT any archive-wide
 * count) so the SSR-seeded page-1 hash (listPublishedIds) and the live span hash
 * (listPublishedSpanState) agree for identical rows — the client's first poll is a
 * true no-op instead of a spurious reconcile (#S2-007 review).
 */
function streamHash(rows: StateRow[]): string {
  const h = createHash('sha256');
  for (const r of rows) {
    // Driver-dependent: PGlite returns `id` as a number, pg as a string — coerce.
    h.update(`\n${String(r.id)}:${String(r.marker)}`);
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Cheap consent-gated fingerprint of the current view (CCB-S2-006): the published
 * item ids for the instance's active filters (same order/window as
 * {@link listPublishedItems}) plus a version hash. Reads ONLY through
 * `published_messages`, so a recalled / unpublished / rejected id can never appear
 * here — when one leaves the set the hash changes, and the client drops the card.
 * Ids + an md5 content marker only — no bodies, no links, no media bytes: this is
 * the poll endpoint's hot path, kept as light as possible.
 */
export async function listPublishedIds(
  db: Queryable,
  enabledTypes: readonly ArchiveType[],
  f: PublicFilters,
): Promise<PublishedState> {
  if (enabledTypes.length === 0) return { ids: [], hash: streamHash([]), total: 0 };

  const { whereSql, params } = buildPublishedWhere(enabledTypes, f);
  const countRes = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM published_messages m ${whereSql}`,
    params,
  );

  const offset = Math.min((f.page - 1) * f.pageSize, Number.MAX_SAFE_INTEGER);
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const res = await db.query<StateRow>(
    `SELECT m.id,
            md5(coalesce(m.text_body, '') || ':' || coalesce(m.media_path, '')) AS marker
     FROM published_messages m
     ${whereSql}
     ORDER BY m.sent_at DESC, m.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, f.pageSize, offset],
  );

  const total = Number(countRes.rows[0]?.n ?? 0);
  return { ids: res.rows.map((r) => Number(r.id)), hash: streamHash(res.rows), total };
}

/** Consent-gated fingerprint of the loaded SPAN (CCB-S2-007 live reconcile). */
export interface SpanState {
  /** Published ids within the loaded band, newest-first. */
  ids: number[];
  /** Version hash over those ids + content markers. */
  hash: string;
  /** True when a published item exists NEWER than `top` (a new publish to prepend). */
  hasNewer: boolean;
}

/**
 * Fingerprints the client's currently-loaded band `[bottom, top]` (both inclusive)
 * for the infinite-scroll live reconcile (CCB-S2-007). The client always sends its
 * `top` (topmost rendered cursor), so the span is bounded to EXACTLY the loaded band
 * (≤ WINDOW_CAP) and the `cap` LIMIT never truncates — a head→bottom span would drop
 * the oldest loaded cards once the top is windowed off and wrongly sweep published
 * content. Reads ONLY `published_messages`: a recalled id simply leaves the set (the
 * client removes that card); `hasNewer` (a cheap EXISTS above `top`) tells an
 * at-top client to prepend new publishes. Ids + markers only — never bodies/media.
 */
export async function listPublishedSpanState(
  db: Queryable,
  enabledTypes: readonly ArchiveType[],
  f: Pick<PublicFilters, 'type' | 'since' | 'until' | 'q'>,
  bottom: Cursor,
  top: Cursor | null,
  cap: number,
): Promise<SpanState> {
  if (enabledTypes.length === 0) return { ids: [], hash: streamHash([]), hasNewer: false };

  const { whereSql, params } = buildPublishedWhere(enabledTypes, f);
  const bTs = `$${params.length + 1}`;
  const bId = `$${params.length + 2}`;
  params.push(bottom.sentAt, bottom.id);
  // Lower bound: newer-than-or-equal to `bottom`.
  let clause =
    ` AND (m.sent_at > ${bTs}::timestamptz` +
    ` OR (m.sent_at = ${bTs}::timestamptz AND m.id >= ${bId}::bigint))`;
  if (top) {
    const tTs = `$${params.length + 1}`;
    const tId = `$${params.length + 2}`;
    params.push(top.sentAt, top.id);
    // Upper bound: older-than-or-equal to `top`.
    clause +=
      ` AND (m.sent_at < ${tTs}::timestamptz` +
      ` OR (m.sent_at = ${tTs}::timestamptz AND m.id <= ${tId}::bigint))`;
  }
  const limitP = `$${params.length + 1}`;
  const res = await db.query<StateRow>(
    `SELECT m.id,
            md5(coalesce(m.text_body, '') || ':' || coalesce(m.media_path, '')) AS marker
     FROM published_messages m
     ${whereSql}${clause}
     ORDER BY m.sent_at DESC, m.id DESC
     LIMIT ${limitP}`,
    [...params, cap],
  );

  let hasNewer = false;
  if (top) {
    const { whereSql: w2, params: p2 } = buildPublishedWhere(enabledTypes, f);
    const nTs = `$${p2.length + 1}`;
    const nId = `$${p2.length + 2}`;
    p2.push(top.sentAt, top.id);
    const ex = await db.query<{ e: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM published_messages m ${w2}
         AND (m.sent_at > ${nTs}::timestamptz
              OR (m.sent_at = ${nTs}::timestamptz AND m.id > ${nId}::bigint))
       ) AS e`,
      p2,
    );
    hasNewer = Boolean(ex.rows[0]?.e);
  }

  return {
    ids: res.rows.map((r) => Number(r.id)),
    hash: streamHash(res.rows),
    hasNewer,
  };
}

/**
 * True iff the message is CURRENTLY published — the consent gate for the public
 * report endpoint (CCB-S2-009). Reading through `published_messages` means an
 * unpublished / recalled / deleted / no-consent / unknown id is non-reportable,
 * with no existence oracle (the caller returns the same neutral confirmation).
 */
export async function isPublished(db: Queryable, messageId: number): Promise<boolean> {
  const { rows } = await db.query<{ one: number }>(
    'SELECT 1 AS one FROM published_messages WHERE id = $1',
    [messageId],
  );
  return rows.length > 0;
}

export interface PublishedMedia {
  /**
   * The path to SERVE. Always the stripped derivative for a format that has a
   * stripper; the original only for formats this instance cannot strip.
   */
  mediaPath: string;
  mediaMime: string | null;
  type: ArchiveType;
  /** True when what is being served is the stripped copy, not the original. */
  stripped: boolean;
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
    media_derived_path: string | null;
    media_strip_skipped: string | null;
    media_mime: string | null;
    type: string;
  }>(
    `SELECT media_path, media_derived_path, media_strip_skipped, media_mime, type::text AS type
     FROM published_messages
     WHERE id = $1`,
    [messageId],
  );
  const r = rows[0];
  if (!r || !r.media_path) return null;

  // THE METADATA GATE (CCB-S3-011 §1). A format that CAN be stripped is served
  // only from its derivative. A missing derivative means stripping has not
  // happened yet, and the safe reading of that is "not publishable" — never
  // "publish the original", which is precisely the leak being closed.
  if (r.media_derived_path) {
    return {
      mediaPath: r.media_derived_path,
      mediaMime: r.media_mime,
      type: r.type as ArchiveType,
      stripped: true,
    };
  }
  // No derivative. Only formats with no stripper on this instance may fall
  // through, and only because they were recorded as such at capture time.
  if (!r.media_strip_skipped) return null;
  return {
    mediaPath: r.media_path,
    mediaMime: r.media_mime,
    type: r.type as ArchiveType,
    stripped: false,
  };
}

/** Newest published item's `sent_at` (ISO), for sitemap/feed `lastmod`. Null when
 * nothing is published for the enabled types — the consent gate again. */
export async function publishedLastmod(
  db: Queryable,
  enabledTypes: readonly ArchiveType[],
): Promise<string | null> {
  if (enabledTypes.length === 0) return null;
  const list = enabledTypes.map((t) => `'${t}'`).join(', ');
  const { rows } = await db.query<{ ts: string | null }>(
    `SELECT max(sent_at) AS ts FROM published_messages WHERE type IN (${list})`,
  );
  const ts = rows[0]?.ts;
  return ts ? new Date(ts).toISOString() : null;
}

/**
 * How many PUBLISHED messages match a free-text query — the number behind
 * Cinderella's SEARCH answer in chat (CCB-S3-002 §5).
 *
 * It reads `published_messages`, so a member searching in the group is told only
 * about the archive as the public sees it: a count here can never reveal that an
 * unpublished, recalled or deleted message exists. The query goes through
 * `websearch_to_tsquery`, the same parser the public front uses, so it is a bind
 * parameter and never string-built SQL.
 */
export async function countPublishedMatching(db: Queryable, q: string): Promise<number> {
  const term = q.trim();
  if (!term) return 0;
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM published_messages
     WHERE search @@ websearch_to_tsquery('simple', $1)`,
    [term],
  );
  return Number(rows[0]?.n ?? 0);
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
