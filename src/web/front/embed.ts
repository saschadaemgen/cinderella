/**
 * Public archive front — the `/embed/<id>` routes (CCB-S2-003).
 *
 * PUBLIC, no auth (registered outside the admin auth guard; see server.ts
 * isPublic). Two routes:
 *   GET /embed/:id                 — SSR HTML page of published content.
 *   GET /embed/:id/media/:msgId    — a single published item's media file.
 *
 * CONSENT INVARIANT: both routes read only through `published_messages`
 * (src/db/public-archive.ts). The media route resolves the file via
 * {@link getPublishedMedia} every request — an unpublished / re-unpublished /
 * deleted item's media 404s; never served by raw path.
 *
 * These responses carry their OWN headers (embeddable, indexable, no-store) — the
 * admin strict headers (frame-DENY, noindex) are skipped for `/embed/*` in the
 * server's onSend hook. Content is server-side rendered (SEO foundation).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getEmbedInstance } from '../../db/embeds.js';
import {
  ARCHIVE_TYPES,
  getPublishedMedia,
  latestPublishedImageId,
  listPublishedItems,
  type ArchiveType,
  type PublicFilters,
} from '../../db/public-archive.js';
import { renderEmbedPage, type PresentationConfig, type RenderContext } from './render.js';
import type { ViewContext } from '../server.js';

const PAGE_SIZE = 30;
const MAX_PAGE = 1_000_000;
const MAX_Q = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for any path this module owns — used by the server to skip admin headers/auth. */
export function isEmbedPath(path: string): boolean {
  return path === '/embed' || path.startsWith('/embed/');
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

/** The embed response headers: embeddable anywhere, indexable, consent-fresh. */
function applyEmbedHeaders(reply: FastifyReply, nonce: string): void {
  reply.header(
    'content-security-policy',
    [
      "default-src 'none'",
      "img-src 'self'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      'frame-ancestors *',
      "base-uri 'none'",
      "form-action 'self'",
      "connect-src 'none'",
    ].join('; '),
  );
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  // Consent freshness: publish/unpublish/delete must reflect immediately. Caching
  // (with invalidation on those events) is the flagged follow-up.
  reply.header('cache-control', 'no-store');
  // x-frame-options is deliberately NOT set (frame-ancestors governs framing).
}

export function registerPublicEmbed(app: FastifyInstance, ctx: ViewContext): void {
  const origin = ctx.adminCfg.publicOrigin.replace(/\/+$/, '');

  app.get<{ Params: { id: string }; Querystring: EmbedQuery }>('/embed/:id', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance) return reply.code(404).type('text/plain').send('Not found');

    const s = instance.settings;
    const enabledTypes = ARCHIVE_TYPES.filter((t) => s.media[t]);
    const basePath = `${origin}/embed/${instance.id}`;

    // Parse + validate visitor filters (only honour filters the instance enables).
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

    // Build conditionally — exactOptionalPropertyTypes forbids `undefined` values.
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

    const presentation: PresentationConfig = {
      template: 'default',
      theme: s.theme,
      layout: s.layout,
    };

    // Per-page title/description (sensible defaults; explicit fields land in
    // CCB-S2-004). Keeps filtered/search views uniquely titled for SEO.
    const baseTitle = instance.name || 'Community Archive';
    const title = q ? `Search “${q}” — ${baseTitle}` : baseTitle;
    const description =
      `A consent-first public archive — only messages members chose to publish. ` +
      `Searchable and permanent.`;

    const canonicalUrl = `${basePath}${canonicalQuery(filters)}`;
    const nonce = randomBytes(16).toString('base64');

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
      canonicalUrl,
      ogImageUrl: ogImageId != null ? `${basePath}/media/${ogImageId}` : null,
      title,
      description,
      nonce,
    };

    applyEmbedHeaders(reply, nonce);
    reply.type('text/html; charset=utf-8');
    return renderEmbedPage(renderCtx);
  });

  app.get<{ Params: { id: string; msgId: string } }>(
    '/embed/:id/media/:msgId',
    async (req, reply) => {
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).type('text/plain').send('Not found');

      const messageId = Number.parseInt(req.params.msgId, 10);
      if (!Number.isInteger(messageId) || messageId < 1) {
        return reply.code(404).type('text/plain').send('Not found');
      }

      // Consent gate: only resolves for a currently-published item.
      const media = await getPublishedMedia(ctx.db, messageId);
      if (!media) return reply.code(404).type('text/plain').send('Not found');
      // The instance must expose this media type, too.
      if (!instance.settings.media[media.type]) {
        return reply.code(404).type('text/plain').send('Not found');
      }

      // Resolve within MEDIA_ROOT and guard against path traversal (defence in
      // depth — the stored path is app-written, but never trust it blindly).
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
      // Never inline-render an untrusted file as active content.
      reply.header('content-disposition', dispositionFor(media.type));
      // Consent freshness (see page route). Caching is the flagged follow-up.
      reply.header('cache-control', 'no-store');
      return reply.send(createReadStream(filePath));
    },
  );
}

/** Images render inline; everything else downloads. */
function dispositionFor(type: ArchiveType): string {
  return type === 'image' || type === 'video' || type === 'voice' ? 'inline' : 'attachment';
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
