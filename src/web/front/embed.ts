/**
 * Public archive front — the `/embed/<id>` routes + SEO artifacts (CCB-S2-003/004).
 *
 * PUBLIC, no auth (registered outside the admin auth guard; see server.ts). Routes:
 *   GET /embed/:id                 — SSR HTML page of published content.
 *   GET /embed/:id/media/:msgId    — a single published item's media file.
 *   GET /embed/:id/sitemap.xml     — per-instance sitemap (published URLs).
 *   GET /embed/:id/feed.xml        — RSS feed (published items).
 *   GET /embed/:id/og.png          — auto social-preview image (from the title).
 *   GET /robots.txt                — allow the front, disallow admin, ref sitemap.
 *   GET /sitemap.xml               — sitemap index over all instances.
 *
 * CONSENT INVARIANT (D-016): every route reads only through `published_messages`.
 * No sitemap, feed, structured-data, or preview ever references unpublished content.
 * These responses carry their OWN headers (embeddable, indexable, no-store) — the
 * admin strict headers are skipped for the public front in the server onSend hook.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getEmbedInstance, listEmbedInstances, type EmbedSettings } from '../../db/embeds.js';
import { VIDEO_FRAME_ORIGIN } from '../../media/video.js';
import { ensureDerivative } from '../../media/pipeline.js';
import {
  ARCHIVE_TYPES,
  decodeCursor,
  getPublishedMedia,
  isPublished,
  latestPublishedImageId,
  listPublishedIds,
  listPublishedItems,
  listPublishedItemsByCursor,
  listPublishedSpanState,
  publishedLastmod,
  type ArchiveType,
  type CursorDir,
  type PublicFilters,
} from '../../db/public-archive.js';
import { createReport, reporterHash, REPORT_REASONS, type ReportReason } from '../../db/reports.js';
import {
  renderCards,
  renderEmbedPage,
  type PresentationConfig,
  type RenderContext,
} from './render.js';
import { GlobalRateLimiter } from '../auth.js';
import {
  buildFeedXml,
  buildOgSvg,
  buildRobotsTxt,
  buildSitemapIndexXml,
  buildSitemapXml,
  resolveSeoHead,
  type SeoContext,
} from './seo.js';
import type { ViewContext } from '../server.js';

const PAGE_SIZE = 30;
const FEED_SIZE = 40;
const MAX_PAGE = 1_000_000;
const MAX_Q = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Per-IP ceiling for the live-update poll endpoints (CCB-S2-006). A normal viewer
 * polls state every ~18s (~3/min) and fetches a fragment only on a real change, so
 * this leaves generous headroom for shared NATs while capping a script that hammers
 * the endpoints. These routes are otherwise exempt from the admin rate limit.
 */
const POLL_RATE_PER_MIN = 120;
/** Cursor page size for infinite scroll (CCB-S2-007) — 30–50 band; server-fixed so
 * a client can never request a huge chunk. Distinct from the SSR `PAGE_SIZE` (30);
 * the cursor is an exact row boundary, so mixing sizes never dupes/skips. */
const CURSOR_PAGE_SIZE = 40;
/** DOM windowing cap the client enforces + the span-state LIMIT ceiling. */
const WINDOW_CAP = 200;
/** `/state` span LIMIT — WINDOW_CAP plus margin. The client always sends `top`, so
 * the span is bounded to the loaded band (≤ WINDOW_CAP) and this never truncates. */
const SPAN_CAP = WINDOW_CAP + 50;
/** Per-IP ceiling for the cursor `/page` endpoint. Its OWN bucket (not the poll's),
 * so a scroll burst can't 429 the consent-critical `/state` poll. */
const PAGE_RATE_PER_MIN = 240;
/** Per-IP ceiling for the public report endpoint (CCB-S2-009) — far stricter than the
 * poll, since a report is a rare deliberate action and the surface is abuse-prone. */
const REPORT_RATE_PER_MIN = 10;

/** True for any path the public front owns (skip admin headers/auth/IP/rate-limit). */
export function isPublicFront(path: string): boolean {
  return (
    path === '/embed' ||
    path.startsWith('/embed/') ||
    path === '/robots.txt' ||
    path === '/sitemap.xml'
  );
}

function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

interface EmbedQuery {
  type?: string;
  since?: string;
  until?: string;
  q?: string;
  page?: string;
  /** Cursor pagination (CCB-S2-007). */
  cursor?: string;
  /** `/state` upper-bound cursor (topmost loaded card). */
  top?: string;
  /** `/page` direction: 'older' (default) or 'newer'. */
  dir?: string;
  /** Set to '1' after a report is filed (renders the confirmation banner). */
  reported?: string;
}

/**
 * The embed page headers: embeddable anywhere, indexable, consent-fresh. When the
 * operator configures an analytics script, its origin is added to script-src +
 * connect-src for THIS instance's page only — the CSP is never weakened silently
 * or globally (the admin form states this tradeoff).
 */
function applyEmbedHeaders(
  reply: FastifyReply,
  nonce: string,
  analyticsHost: string,
  hasVideoCard = false,
): void {
  const scriptSrc = analyticsHost ? `'nonce-${nonce}' ${analyticsHost}` : `'nonce-${nonce}'`;
  // frame-src is added ONLY on a page that actually contains a video card, and
  // ONLY for the nocookie player origin (CCB-S3-014 §4). No script-src or img-src
  // widening: the player brings its own context in an iframe, and thumbnails are
  // served from 'self'. Absent this line, `default-src 'none'` blocks all frames.
  const frameSrc = hasVideoCard ? `frame-src ${VIDEO_FRAME_ORIGIN}` : "frame-src 'none'";
  // 'self' is required for the live-update client's same-origin poll (CCB-S2-006):
  // fetch() to /embed/:id/state and /fragment. An analytics origin, if configured,
  // is added on top for this instance only.
  const connectSrc = analyticsHost ? `'self' ${analyticsHost}` : "'self'";
  reply.header(
    'content-security-policy',
    [
      "default-src 'none'",
      "img-src 'self'",
      // Inline <video>/<audio> playback (CCB-S2-008) — own consent-gated media only.
      "media-src 'self'",
      frameSrc,
      `style-src 'nonce-${nonce}'`,
      `script-src ${scriptSrc}`,
      'frame-ancestors *',
      "base-uri 'none'",
      "form-action 'self'",
      `connect-src ${connectSrc}`,
    ].join('; '),
  );
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('cache-control', 'no-store');
}

export function registerPublicEmbed(app: FastifyInstance, ctx: ViewContext): void {
  const origin = ctx.adminCfg.publicOrigin.replace(/\/+$/, '');

  // Per-IP limiters for the visitor-driven public endpoints. The `/state` poll and
  // the `/page` cursor endpoint get SEPARATE buckets (CCB-S2-007) so a scroll burst
  // on `/page` can never 429 the consent-critical `/state` poll. Both are otherwise
  // exempt from the admin rate limit.
  const pollLimiter = new GlobalRateLimiter(() => POLL_RATE_PER_MIN);
  const pageLimiter = new GlobalRateLimiter(() => PAGE_RATE_PER_MIN);
  const reportLimiter = new GlobalRateLimiter(() => REPORT_RATE_PER_MIN);
  let sincePrune = 0;
  const limited = (reply: FastifyReply, ip: string, limiter: GlobalRateLimiter): boolean => {
    if (++sincePrune >= 200) {
      sincePrune = 0;
      pollLimiter.prune();
      pageLimiter.prune();
      reportLimiter.prune();
    }
    if (limiter.allow(ip)) return true;
    reply.code(429).header('cache-control', 'no-store').header('retry-after', '30');
    return false;
  };
  const pollAllowed = (reply: FastifyReply, ip: string): boolean => limited(reply, ip, pollLimiter);
  const pageAllowed = (reply: FastifyReply, ip: string): boolean => limited(reply, ip, pageLimiter);
  const reportAllowed = (reply: FastifyReply, ip: string): boolean =>
    limited(reply, ip, reportLimiter);

  // --- The SSR page ---
  app.get<{ Params: { id: string }; Querystring: EmbedQuery }>('/embed/:id', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance) return reply.code(404).type('text/plain').send('Not found');

    const s = instance.settings;
    const basePath = `${origin}/embed/${instance.id}`;
    const { enabledTypes, filters } = resolveView(s, req.query);
    const page = filters.page;

    const { items, total } = await listPublishedItems(ctx.db, enabledTypes, filters);
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // Initial version hash so the live-update client's first poll is a no-op unless
    // the set genuinely changed since render (CCB-S2-006). Same value the state
    // endpoint returns; a cheap ids+hash query, not a re-render.
    const { hash: streamHash } = await listPublishedIds(ctx.db, enabledTypes, filters);
    const ogImageId = await latestPublishedImageId(ctx.db, enabledTypes);

    const seoCtx: SeoContext = {
      instance,
      seo: s.seo,
      filters,
      items,
      total,
      origin,
      basePath,
      canonicalUrl: `${basePath}${canonicalQuery(filters)}`,
      ogImageId,
      page,
      pageCount,
    };
    const seo = resolveSeoHead(seoCtx);

    const presentation: PresentationConfig = {
      template: 'default',
      theme: s.theme,
      layout: s.layout,
    };
    const nonce = randomBytes(16).toString('base64');
    const analyticsHost = analyticsOrigin(s.seo.analytics.scriptUrl);
    const videoOpts = {
      embed: s.video.embed,
      providers: s.video.providers,
      showNotice: s.video.showNotice,
    };
    // Whether any card on THIS page will render a player, so the CSP frame-src
    // is widened only where a video card actually exists (CCB-S3-014 §4).
    const hasVideoCard =
      videoOpts.embed &&
      items.some((it) => it.video && it.type === 'link' && videoOpts.providers.includes(it.video.provider));

    const renderCtx: RenderContext = {
      presentation,
      enabledFilters: s.filters,
      filters,
      items,
      total,
      page,
      pageCount,
      basePath,
      origin,
      seo,
      nonce,
      showDownload: s.player.showDownload,
      video: videoOpts,
      streamHash,
      nextCursor: items.length > 0 ? (items[items.length - 1]?.cursor ?? '') : '',
      hasMore: (page - 1) * PAGE_SIZE + items.length < total,
      windowCap: WINDOW_CAP,
      cursorPageSize: CURSOR_PAGE_SIZE,
      reported: req.query.reported === '1',
    };

    applyEmbedHeaders(reply, nonce, analyticsHost, hasVideoCard);
    reply.type('text/html; charset=utf-8');
    return renderEmbedPage(renderCtx);
  });

  // --- Live-update state (CCB-S2-006/007): consent-gated ids + version hash ---
  // The poll hot path. With a `cursor` (client bottom) + `top` it fingerprints the
  // client's EXACT loaded band (CCB-S2-007 infinite scroll) and reports `hasNewer`;
  // without a cursor it keeps the legacy page-1 window (empty-view fallback). Reads
  // ONLY published_messages, so a recalled/unpublished id can never appear.
  app.get<{ Params: { id: string }; Querystring: EmbedQuery }>(
    '/embed/:id/state',
    async (req, reply) => {
      if (!pollAllowed(reply, req.ip)) return { error: 'rate_limited' };
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).type('application/json').send({ error: 'not_found' });
      const { enabledTypes, filters } = resolveView(instance.settings, req.query);
      // Short TTL: cache-friendly yet consent-fresh within the poll interval. The
      // payload carries ids + hash only — never content — so a briefly stale hash
      // can at most delay a card's removal by the TTL, never leak anything.
      reply.header('cache-control', 'public, max-age=5');
      reply.header('x-content-type-options', 'nosniff');
      reply.type('application/json; charset=utf-8');

      const bottom = typeof req.query.cursor === 'string' ? decodeCursor(req.query.cursor) : null;
      if (bottom) {
        const top = typeof req.query.top === 'string' ? decodeCursor(req.query.top) : null;
        const span = await listPublishedSpanState(
          ctx.db,
          enabledTypes,
          filters,
          bottom,
          top,
          SPAN_CAP,
        );
        return { hash: span.hash, ids: span.ids, hasNewer: span.hasNewer };
      }
      const state = await listPublishedIds(ctx.db, enabledTypes, filters);
      return { hash: state.hash, ids: state.ids, hasNewer: false };
    },
  );

  // --- Cursor page (CCB-S2-007): the next infinite-scroll chunk of cards ---
  // JSON envelope { html, nextCursor, hasMore }. `html` is the bare <li> card
  // sequence (reuses renderCards, byte-identical to SSR) for insertAdjacentHTML.
  // Consent-gated through published_messages; a malformed cursor is a 400, never a
  // silent page-1 (which would dupe cards). Its own per-IP rate limit.
  app.get<{ Params: { id: string }; Querystring: EmbedQuery }>(
    '/embed/:id/page',
    async (req, reply) => {
      if (!pageAllowed(reply, req.ip)) return { error: 'rate_limited' };
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).type('application/json').send({ error: 'not_found' });
      const { enabledTypes, filters } = resolveView(instance.settings, req.query);
      let cursor = null;
      if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
        cursor = decodeCursor(req.query.cursor);
        if (!cursor) return reply.code(400).type('application/json').send({ error: 'bad_cursor' });
      }
      const dir: CursorDir = req.query.dir === 'newer' ? 'newer' : 'older';
      const chunk = await listPublishedItemsByCursor(
        ctx.db,
        enabledTypes,
        filters,
        cursor,
        dir,
        CURSOR_PAGE_SIZE,
      );
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      reply.type('application/json; charset=utf-8');
      return {
        html: renderCards(
          chunk.items,
          `${origin}/embed/${instance.id}`,
          instance.settings.player.showDownload,
          {
            embed: instance.settings.video.embed,
            providers: instance.settings.video.providers,
            showNotice: instance.settings.video.showNotice,
          },
        ).toString(),
        nextCursor: chunk.nextCursor,
        hasMore: chunk.hasMore,
      };
    },
  );

  // --- Public content report (CCB-S2-009): flag a published item for operator review ---
  // The ONE mutating public-front route (exempt from the admin CSRF/auth preHandler in
  // server.ts — a public surface with no session to defend). It NEVER changes publication
  // (visible-until-review): it only writes the reports table. Protections: a strict rate
  // limit, the published-only gate (no existence oracle), a per-item-per-day dedup, and
  // enum/length validation. Same-origin plain <form> POST (CSP form-action 'self').
  app.post<{ Params: { id: string }; Body: { msg?: string; reason?: string; note?: string } }>(
    '/embed/:id/report',
    async (req, reply) => {
      if (!reportAllowed(reply, req.ip)) return 'Too many reports — please try again shortly.';
      // Reject cross-SITE auto-submissions (CCB-S2-009 review): the report form is always
      // served from THIS origin — even when the archive runs inside a third-party iframe —
      // so a legitimate submit is same-origin. A malicious third-party page auto-POSTing
      // here is cross-site; blocking it stops the queue from being flooded via drive-by
      // forms. Modern browsers send Sec-Fetch-Site; absent (older clients) → fall through
      // (the rate limit still applies). No item lookup happens first, so no oracle.
      if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') {
        return reply.code(403).type('text/plain').send('Cross-site reports are not accepted.');
      }
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).type('text/plain').send('Not found');
      const basePath = `${origin}/embed/${instance.id}`;
      // PRG: identical neutral confirmation whether or not a row was stored — a reporter
      // (or an attacker) can never tell published from unpublished/nonexistent/deduped.
      const confirm = (): FastifyReply => reply.redirect(`${basePath}?reported=1`, 303);

      const body = req.body ?? {};
      const reason = typeof body.reason === 'string' ? body.reason : '';
      if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
        return reply.code(400).type('text/plain').send('Invalid reason');
      }
      const msgId = Number.parseInt(typeof body.msg === 'string' ? body.msg : '', 10);
      if (!Number.isInteger(msgId) || msgId < 1) return confirm();
      // Consent gate: only currently-published items are reportable (D-016).
      if (!(await isPublished(ctx.db, msgId))) return confirm();

      const noteRaw = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
      const note = noteRaw.length > 0 ? noteRaw : null;
      const utcDate = new Date().toISOString().slice(0, 10);
      const hash = reporterHash(ctx.adminCfg.sessionSecret, req.ip, msgId, utcDate);
      await createReport(ctx.db, {
        messageId: msgId,
        reason: reason as ReportReason,
        note,
        reporterHash: hash,
      });
      return confirm();
    },
  );

  // --- Media (consent-gated per request) ---
  app.get<{ Params: { id: string; msgId: string } }>(
    '/embed/:id/media/:msgId',
    async (req, reply) => {
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).type('text/plain').send('Not found');
      const messageId = Number.parseInt(req.params.msgId, 10);
      if (!Number.isInteger(messageId) || messageId < 1) {
        return reply.code(404).type('text/plain').send('Not found');
      }
      let media = await getPublishedMedia(ctx.db, messageId);
      if (!media) {
        // SELF-HEAL (CCB-S3-011 Addendum A). A missing derivative used to be a
        // permanent 404: the gate withheld the image and nothing ever tried
        // again, so one transient fault — a permission, a full disk — made a
        // photograph invisible forever while the stream just looked empty.
        // Retrying the STRIP is the fix; falling back to the original is not,
        // so this stays fail-closed when stripping genuinely cannot be done.
        const healed = await healMissingDerivative(ctx, messageId);
        if (!healed) return reply.code(404).type('text/plain').send('Not found');
        media = healed;
      }
      if (!instance.settings.media[media.type]) {
        return reply.code(404).type('text/plain').send('Not found');
      }
      const root = resolve(ctx.cfg.mediaRoot);
      const filePath = resolve(root, media.mediaPath);
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        return reply.code(404).type('text/plain').send('Not found');
      }
      let size: number;
      try {
        const st = await stat(filePath);
        if (!st.isFile()) throw new Error('not a file');
        size = st.size;
      } catch {
        return reply.code(404).type('text/plain').send('Not found');
      }
      reply.header('content-type', media.mediaMime ?? 'application/octet-stream');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-disposition', dispositionFor(media.type));
      reply.header('cache-control', 'no-store');
      // Byte-range support (CCB-S2-008): WebKit REQUIRES it to play inline <video>,
      // and it enables seeking everywhere. The consent gate (getPublishedMedia) and
      // the path-containment guard already ran above, so a recalled/unpublished id
      // still 404s before any bytes — the range branch only reshapes an allowed body.
      reply.header('accept-ranges', 'bytes');
      const rangeHeader = req.headers.range;
      const m =
        typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
      if (m && (m[1] || m[2])) {
        let start: number;
        let end: number;
        if (m[1]) {
          start = Number.parseInt(m[1], 10);
          end = m[2] ? Number.parseInt(m[2], 10) : size - 1;
        } else {
          // Suffix range `bytes=-N` → the last N bytes.
          start = Math.max(0, size - Number.parseInt(m[2] as string, 10));
          end = size - 1;
        }
        end = Math.min(end, size - 1);
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
          return reply.code(416).header('content-range', `bytes */${size}`).send();
        }
        reply.code(206);
        reply.header('content-range', `bytes ${start}-${end}/${size}`);
        reply.header('content-length', String(end - start + 1));
        return reply.send(createReadStream(filePath, { start, end }));
      }
      reply.header('content-length', String(size));
      return reply.send(createReadStream(filePath));
    },
  );

  // --- Per-instance sitemap (published URLs only) ---
  app.get<{ Params: { id: string } }>('/embed/:id/sitemap.xml', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance) return reply.code(404).type('text/plain').send('Not found');
    const s = instance.settings;
    const enabledTypes = ARCHIVE_TYPES.filter((t) => s.media[t]);
    const { total } = await listPublishedItems(ctx.db, enabledTypes, {
      page: 1,
      pageSize: PAGE_SIZE,
    });
    const lastmod = await publishedLastmod(ctx.db, enabledTypes);
    const canonicalBase = (s.seo.canonicalBase || origin).replace(/\/+$/, '');
    const xml = buildSitemapXml({
      seo: s.seo,
      basePath: `${origin}/embed/${instance.id}`,
      canonicalBasePath: `${canonicalBase}/embed/${instance.id}`,
      total,
      pageSize: PAGE_SIZE,
      enabledTypes,
      enabledFilters: { byType: s.filters.byType },
      lastmod,
    });
    reply.header('cache-control', 'no-store');
    reply.type('application/xml; charset=utf-8');
    return xml;
  });

  // --- Per-instance RSS feed (published items only) ---
  app.get<{ Params: { id: string } }>('/embed/:id/feed.xml', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance) return reply.code(404).type('text/plain').send('Not found');
    const s = instance.settings;
    if (!s.seo.feed.enabled) return reply.code(404).type('text/plain').send('Not found');
    const enabledTypes = ARCHIVE_TYPES.filter((t) => s.media[t]);
    const basePath = `${origin}/embed/${instance.id}`;
    const { items } = await listPublishedItems(ctx.db, enabledTypes, {
      page: 1,
      pageSize: FEED_SIZE,
    });
    const lastmod = await publishedLastmod(ctx.db, enabledTypes);
    const title = (s.seo.titleTemplate || '{instance}')
      .replaceAll('{instance}', instance.name)
      .replaceAll('{section}', '');
    const xml = buildFeedXml({
      instance,
      items,
      basePath,
      title: title || instance.name,
      description: s.seo.description || `Published archive of ${instance.name}`,
      lastmod,
    });
    reply.header('cache-control', 'no-store');
    reply.type('application/rss+xml; charset=utf-8');
    return xml;
  });

  // --- Auto OG preview image (from the instance title; not consent-sensitive) ---
  app.get<{ Params: { id: string } }>('/embed/:id/og.png', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance || !instance.settings.seo.og.autoImage) {
      return reply.code(404).type('text/plain').send('Not found');
    }
    const svg = buildOgSvg(
      instance.name || 'Community Archive',
      instance.settings.seo.og.siteName,
      instance.settings.theme.colorAccent,
    );
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'public, max-age=3600');
    return reply.send(png);
  });

  // --- Origin robots.txt ---
  app.get('/robots.txt', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    reply.type('text/plain; charset=utf-8');
    return buildRobotsTxt(origin);
  });

  // --- Origin sitemap index (all instances) ---
  app.get('/sitemap.xml', async (_req, reply) => {
    const instances = await listEmbedInstances(ctx.db);
    reply.header('cache-control', 'no-store');
    reply.type('application/xml; charset=utf-8');
    return buildSitemapIndexXml(
      instances.map((i) => i.id),
      origin,
    );
  });
}

/**
 * Resolves the enabled media types + the validated visitor filters for a request.
 * Shared by the page, state, and fragment routes so all three read the IDENTICAL
 * consent-gated view — the poll's ids/hash always match what the page renders.
 */
function resolveView(
  s: EmbedSettings,
  qs: EmbedQuery,
): { enabledTypes: ArchiveType[]; filters: PublicFilters } {
  const enabledTypes = ARCHIVE_TYPES.filter((t) => s.media[t]);
  const rawType = typeof qs.type === 'string' ? qs.type : '';
  const type: ArchiveType | undefined =
    s.filters.byType && (ARCHIVE_TYPES as readonly string[]).includes(rawType)
      ? (rawType as ArchiveType)
      : undefined;
  const since = s.filters.byTime && qs.since && validDate(qs.since) ? qs.since : undefined;
  const until = s.filters.byTime && qs.until && validDate(qs.until) ? qs.until : undefined;
  const q =
    s.filters.search && typeof qs.q === 'string' && qs.q.trim().length > 0
      ? qs.q.trim().slice(0, MAX_Q)
      : undefined;
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(qs.page ?? '1', 10) || 1));
  const filters: PublicFilters = {
    page,
    pageSize: PAGE_SIZE,
    ...(type ? { type } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(q ? { q } : {}),
  };
  return { enabledTypes, filters };
}

/** Images render inline; everything else downloads. */
/**
 * Tries to make the derivative a published image is missing, and returns the
 * media record once it exists. Null when it still cannot be served.
 */
async function healMissingDerivative(
  ctx: ViewContext,
  messageId: number,
): Promise<Awaited<ReturnType<typeof getPublishedMedia>>> {
  const { rows } = await ctx.db.query<{
    media_path: string | null;
    media_mime: string | null;
    media_derived_path: string | null;
  }>(
    `SELECT media_path, media_mime, media_derived_path
       FROM published_messages WHERE id = $1`,
    [messageId],
  );
  const r = rows[0];
  // Not published, or nothing to strip — the gate said no for a real reason.
  if (!r?.media_path || r.media_derived_path) return null;
  const made = await ensureDerivative(
    ctx.db,
    ctx.cfg.mediaRoot,
    messageId,
    r.media_path,
    r.media_mime,
  );
  if (!made) return null;
  return getPublishedMedia(ctx.db, messageId);
}

function dispositionFor(type: ArchiveType): string {
  return type === 'image' || type === 'video' || type === 'voice' ? 'inline' : 'attachment';
}

/** The origin of a configured analytics script URL ('' when unset/invalid). */
function analyticsOrigin(scriptUrl: string): string {
  if (!scriptUrl) return '';
  try {
    return new URL(scriptUrl).origin;
  } catch {
    return '';
  }
}

/** Canonical query — the active filters, sans defaults, deterministic order. */
function canonicalQuery(f: PublicFilters): string {
  const parts: string[] = [];
  if (f.type) parts.push(`type=${encodeURIComponent(f.type)}`);
  if (f.since) parts.push(`since=${encodeURIComponent(f.since)}`);
  if (f.until) parts.push(`until=${encodeURIComponent(f.until)}`);
  if (f.q) parts.push(`q=${encodeURIComponent(f.q)}`);
  if (f.page > 1) parts.push(`page=${f.page}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
