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
import {
  ARCHIVE_TYPES,
  getPublishedMedia,
  latestPublishedImageId,
  listPublishedIds,
  listPublishedItems,
  publishedLastmod,
  type ArchiveType,
  type PublicFilters,
} from '../../db/public-archive.js';
import {
  renderEmbedPage,
  renderStreamFragment,
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
}

/**
 * The embed page headers: embeddable anywhere, indexable, consent-fresh. When the
 * operator configures an analytics script, its origin is added to script-src +
 * connect-src for THIS instance's page only — the CSP is never weakened silently
 * or globally (the admin form states this tradeoff).
 */
function applyEmbedHeaders(reply: FastifyReply, nonce: string, analyticsHost: string): void {
  const scriptSrc = analyticsHost ? `'nonce-${nonce}' ${analyticsHost}` : `'nonce-${nonce}'`;
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

  // Per-IP limiter for the live-update poll endpoints only (state + fragment).
  // The public front is otherwise exempt from the admin rate limit; these two
  // endpoints are visitor-driven and cheap, so they get their own generous cap.
  const pollLimiter = new GlobalRateLimiter(() => POLL_RATE_PER_MIN);
  let sincePrune = 0;
  const pollAllowed = (reply: FastifyReply, ip: string): boolean => {
    if (++sincePrune >= 200) {
      sincePrune = 0;
      pollLimiter.prune();
    }
    if (pollLimiter.allow(ip)) return true;
    reply.code(429).header('cache-control', 'no-store').header('retry-after', '30');
    return false;
  };

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
    };
    const seo = resolveSeoHead(seoCtx);

    const presentation: PresentationConfig = {
      template: 'default',
      theme: s.theme,
      layout: s.layout,
    };
    const nonce = randomBytes(16).toString('base64');
    const analyticsHost = analyticsOrigin(s.seo.analytics.scriptUrl);

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
      streamHash,
    };

    applyEmbedHeaders(reply, nonce, analyticsHost);
    reply.type('text/html; charset=utf-8');
    return renderEmbedPage(renderCtx);
  });

  // --- Live-update state (CCB-S2-006): cheap consent-gated ids + version hash ---
  // The poll hot path. Resolves ONLY through published_messages, so a recalled or
  // unpublished id can never appear; the returned hash changes when the set (or an
  // item's content) changes, which is the client's signal to fetch the fragment.
  app.get<{ Params: { id: string }; Querystring: EmbedQuery }>(
    '/embed/:id/state',
    async (req, reply) => {
      if (!pollAllowed(reply, req.ip)) return { error: 'rate_limited' };
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).type('application/json').send({ error: 'not_found' });
      const { enabledTypes, filters } = resolveView(instance.settings, req.query);
      const state = await listPublishedIds(ctx.db, enabledTypes, filters);
      // Short TTL: cache-friendly yet consent-fresh within the poll interval. The
      // payload carries ids + hash only — never content — so a briefly stale hash
      // can at most delay a card's removal by the TTL, never leak anything.
      reply.header('cache-control', 'public, max-age=5');
      reply.header('x-content-type-options', 'nosniff');
      reply.type('application/json; charset=utf-8');
      return { hash: state.hash, ids: state.ids };
    },
  );

  // --- Live-update fragment (CCB-S2-006): the re-rendered #stream-list region ---
  // Same consent-gated items as the full page, minus head/theme/scripts. Fetched
  // only when the state hash changed, then swapped into the open page's DOM.
  app.get<{ Params: { id: string }; Querystring: EmbedQuery }>(
    '/embed/:id/fragment',
    async (req, reply) => {
      if (!pollAllowed(reply, req.ip)) return 'Rate limited';
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).type('text/plain').send('Not found');
      const { enabledTypes, filters } = resolveView(instance.settings, req.query);
      const { items, total } = await listPublishedItems(ctx.db, enabledTypes, filters);
      const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const basePath = `${origin}/embed/${instance.id}`;
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      reply.type('text/html; charset=utf-8');
      return renderStreamFragment({
        items,
        filters,
        basePath,
        page: filters.page,
        pageCount,
        showDownload: instance.settings.player.showDownload,
      });
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
      const media = await getPublishedMedia(ctx.db, messageId);
      if (!media) return reply.code(404).type('text/plain').send('Not found');
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
