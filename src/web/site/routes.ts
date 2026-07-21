/**
 * Public marketing site routes (CCB-S2-012) — served at the domain root, SSR,
 * indexable, with its OWN headers (indexable + frame-DENY, unlike the embeddable
 * archive front). Registered outside the admin auth guard via {@link isPublicSitePath}.
 *
 * Routing (per-language, one static route per loaded locale so nothing greedily
 * shadows the admin paths):
 *   GET /                     → 302 to the negotiated language home
 *   GET /<lang>               → localized landing page
 *   GET /<lang>/<slug>        → localized page (built or a clean "coming soon" stub)
 *   GET /sitemap-site.xml     → marketing sitemap (hreflang alternates)
 *
 * The visitor's language choice persists in the essential `cin-lang` cookie (a
 * functional preference, no consent needed — like the theme). Analytics + the cookie
 * banner load nothing here unless the operator enabled them AND the visitor accepts.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ViewContext } from '../server.js';
import type { LocaleSet } from './i18n.js';
import { pageBySlug, HOME } from './pages.js';
import { buildSiteSitemapXml, resolveSiteHead, type SiteSeoContext } from './seo.js';
import { renderSitePage, type SitePageView } from './render.js';
import { shouldLoadAnalytics } from '../../site/settings.js';

const LANG_COOKIE = 'cin-lang';
const LANG_COOKIE_MAX_AGE = 31_536_000; // 1 year

/** True for any path the marketing site owns (root, /<lang>*, the site sitemap). */
export function isPublicSitePath(path: string, codes: readonly string[]): boolean {
  if (path === '/' || path === '/sitemap-site.xml') return true;
  const seg = path.split('/')[1] ?? '';
  return codes.includes(seg);
}

/** The origin of an analytics script URL ('' when unset/invalid). */
function analyticsOrigin(scriptUrl: string): string {
  if (!scriptUrl) return '';
  try {
    return new URL(scriptUrl).origin;
  } catch {
    return '';
  }
}

/**
 * Marketing-site response headers: same nonce-based, self-contained CSP as the
 * archive front, but NON-embeddable (frame-ancestors 'none' + X-Frame-Options DENY)
 * and indexable. When analytics is consent-gated on, its origin is added to
 * script-src + connect-src (the injected snippet only runs after the visitor accepts).
 */
export function applySiteHeaders(
  reply: FastifyReply,
  nonce: string,
  analyticsHost: string,
  robots: string,
): void {
  const scriptSrc = analyticsHost ? `'nonce-${nonce}' ${analyticsHost}` : `'nonce-${nonce}'`;
  const connectSrc = analyticsHost ? `'self' ${analyticsHost}` : "'self'";
  reply.header(
    'content-security-policy',
    [
      "default-src 'none'",
      "img-src 'self' data:",
      "font-src 'self'",
      `style-src 'nonce-${nonce}'`,
      `script-src ${scriptSrc}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      `connect-src ${connectSrc}`,
    ].join('; '),
  );
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  // Robots policy at the HTTP layer, mirroring the page's <meta name="robots">
  // (home indexable; thin stubs noindex). The app owns robots policy so the origin's
  // nginx never needs to blanket-noindex the whole host (CCB-S2-012).
  reply.header('x-robots-tag', robots);
  reply.header('cache-control', 'no-store');
}

/** cookie → Accept-Language → default. */
function negotiateLocale(req: FastifyRequest, locales: LocaleSet): string {
  const cookie = req.cookies?.[LANG_COOKIE];
  if (cookie && locales.has(cookie)) return cookie;
  const header = String(req.headers['accept-language'] ?? '');
  for (const part of header.split(',')) {
    const tag = part.trim().split(';')[0] ?? '';
    const code = tag.split('-')[0]?.toLowerCase() ?? '';
    if (code && locales.has(code)) return code;
  }
  return locales.default;
}

export function registerSiteRoutes(
  app: FastifyInstance,
  ctx: ViewContext,
  locales: LocaleSet,
): void {
  const origin = ctx.adminCfg.publicOrigin.replace(/\/+$/, '');

  const renderPage = (reply: FastifyReply, locale: string, slug: string): string => {
    const page = slug ? (pageBySlug(slug) ?? HOME) : HOME;
    const t = (key: string, vars?: Record<string, string | number>): string =>
      locales.t(locale, key, vars);
    const site = ctx.site.get();
    const seoCtx: SiteSeoContext = { origin, locale, locales, page, t };
    const seo = resolveSiteHead(seoCtx);
    const nonce = randomBytes(16).toString('base64');
    const analyticsHost = shouldLoadAnalytics(site)
      ? analyticsOrigin(site.analytics.scriptUrl)
      : '';
    const view: SitePageView = { locale, locales, page, origin, nonce, seo, site, t };
    applySiteHeaders(reply, nonce, analyticsHost, seo.robots);
    reply.type('text/html; charset=utf-8');
    // Persist the language as a functional (essential) cookie — no consent required.
    reply.setCookie(LANG_COOKIE, locale, {
      path: '/',
      maxAge: LANG_COOKIE_MAX_AGE,
      sameSite: 'lax',
      httpOnly: true,
    });
    return renderSitePage(view);
  };

  // Root → negotiated language home.
  app.get('/', (req, reply) => {
    const locale = negotiateLocale(req, locales);
    reply.header('cache-control', 'no-store');
    return reply.redirect(`/${locale}`, 302);
  });

  // One static route per loaded locale (no greedy `/:lang` that could shadow admin).
  for (const code of locales.codes) {
    app.get(`/${code}`, (_req, reply) => renderPage(reply, code, ''));
    app.get<{ Params: { slug: string } }>(`/${code}/:slug`, (req, reply) => {
      const page = pageBySlug(req.params.slug);
      if (!page) return reply.code(404).type('text/plain').send('Not found');
      return renderPage(reply, code, req.params.slug);
    });
    // Legal sub-pages (CCB-S3-001): two-segment slugs, registered explicitly so
    // nothing greedy exists beyond the catalog.
    app.get<{ Params: { sub: string } }>(`/${code}/legal/:sub`, (req, reply) => {
      const page = pageBySlug(`legal/${req.params.sub}`);
      if (!page) return reply.code(404).type('text/plain').send('Not found');
      return renderPage(reply, code, page.slug);
    });
  }

  // Marketing sitemap (referenced from the origin sitemap index).
  app.get('/sitemap-site.xml', (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    reply.type('application/xml; charset=utf-8');
    return buildSiteSitemapXml(origin, locales);
  });
}
