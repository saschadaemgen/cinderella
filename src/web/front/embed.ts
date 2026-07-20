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
import { getEmbedInstance, listEmbedInstances } from '../../db/embeds.js';
import {
  ARCHIVE_TYPES,
  getPublishedMedia,
  latestPublishedImageId,
  listPublishedItems,
  publishedLastmod,
  type ArchiveType,
  type PublicFilters,
} from '../../db/public-archive.js';
import { renderEmbedPage, type PresentationConfig, type RenderContext } from './render.js';
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
  const connectSrc = analyticsHost ? `${analyticsHost}` : "'none'";
  reply.header(
    'content-security-policy',
    [
      "default-src 'none'",
      "img-src 'self'",
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

  // --- The SSR page ---
  app.get<{ Params: { id: string }; Querystring: EmbedQuery }>('/embed/:id', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance) return reply.code(404).type('text/plain').send('Not found');

    const s = instance.settings;
    const enabledTypes = ARCHIVE_TYPES.filter((t) => s.media[t]);
    const basePath = `${origin}/embed/${instance.id}`;

    const qs = req.query;
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
    const { items, total } = await listPublishedItems(ctx.db, enabledTypes, filters);
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
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
    };

    applyEmbedHeaders(reply, nonce, analyticsHost);
    reply.type('text/html; charset=utf-8');
    return renderEmbedPage(renderCtx);
  });

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
      reply.header('content-length', String(size));
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-disposition', dispositionFor(media.type));
      reply.header('cache-control', 'no-store');
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
