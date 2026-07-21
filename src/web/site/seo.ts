/**
 * Marketing-site SEO (CCB-S2-012) — per-page `<head>` metadata + JSON-LD + hreflang,
 * modelled on the archive front's CCB-S2-004 machinery but for a static multi-page,
 * multi-language site (no consent-gated data flows through here).
 *
 * The home page is indexable; thin "coming soon" stubs are `noindex, follow` (crawl
 * the links, don't index the placeholder). JSON-LD emits Organization + WebSite +
 * SoftwareApplication for the suite, with stable @ids cross-linked by publisher.
 */

import type { LocaleSet } from './i18n.js';
import { HOME, NAV_PAGES, pagePath, type SitePage } from './pages.js';

/** Canonical project links (not translatable). */
export const GITHUB_URL = 'https://github.com/saschadaemgen/cinderella';
export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
export const CONTACT_EMAIL = 'cinderella@simplego.dev';

/** JSON for a <script type="application/ld+json"> — escape `<` so text can't break out. */
function ldJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

const XML_RE = /[&<>"']/g;
const XML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
function xml(v: string): string {
  return v.replace(XML_RE, (c) => XML_ESC[c] ?? c);
}

export interface SiteAlternate {
  hreflang: string;
  href: string;
}

export interface SiteSeoHead {
  title: string;
  description: string;
  canonicalUrl: string;
  robots: string;
  ogTitle: string;
  ogDescription: string;
  ogType: string;
  ogSiteName: string;
  ogLocale: string;
  ogUrl: string;
  twitterCard: string;
  /** hreflang alternates including x-default ('' href never emitted). */
  alternates: SiteAlternate[];
  /** Serialized JSON-LD @graph. */
  jsonLd: string;
}

export interface SiteSeoContext {
  origin: string;
  locale: string;
  locales: LocaleSet;
  page: SitePage;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/** hreflang alternates for a page: one per locale + x-default → the default locale. */
function alternatesFor(c: SiteSeoContext): SiteAlternate[] {
  const alts: SiteAlternate[] = c.locales.codes.map((code) => ({
    hreflang: code,
    href: `${c.origin}${pagePath(code, c.page)}`,
  }));
  alts.push({ hreflang: 'x-default', href: `${c.origin}${pagePath(c.locales.default, c.page)}` });
  return alts;
}

export function resolveSiteHead(c: SiteSeoContext): SiteSeoHead {
  const title = c.t(`meta.${c.page.key}.title`);
  const description = c.t(`meta.${c.page.key}.description`);
  const canonicalUrl = `${c.origin}${pagePath(c.locale, c.page)}`;
  // Built pages are indexable; thin stubs AND draft legal texts are noindex (still
  // followable) so placeholders don't dilute the index while links stay crawlable.
  const robots = c.page.built && !c.page.noindex ? 'index, follow' : 'noindex, follow';
  const ogLocale = c.locales.meta[c.locale]?.ogLocale ?? 'en_US';
  const siteName = c.t('brand.name');

  return {
    title,
    description,
    canonicalUrl,
    robots,
    ogTitle: title,
    ogDescription: description,
    ogType: 'website',
    ogSiteName: siteName,
    ogLocale,
    ogUrl: canonicalUrl,
    twitterCard: 'summary_large_image',
    alternates: alternatesFor(c),
    jsonLd: buildSiteJsonLd(c),
  };
}

function buildSiteJsonLd(c: SiteSeoContext): string {
  const org = {
    '@type': 'Organization',
    '@id': `${c.origin}/#org`,
    name: c.t('brand.name'),
    url: c.origin,
    sameAs: [GITHUB_URL],
  };
  const website = {
    '@type': 'WebSite',
    '@id': `${c.origin}/#website`,
    name: c.t('brand.name'),
    url: c.origin,
    inLanguage: c.locale,
    publisher: { '@id': `${c.origin}/#org` },
  };
  const app = {
    '@type': 'SoftwareApplication',
    '@id': `${c.origin}/#app`,
    name: c.t('brand.name'),
    applicationCategory: 'CommunicationApplication',
    operatingSystem: 'Linux',
    description: c.t('meta.home.description'),
    url: c.origin,
    license: LICENSE_URL,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@id': `${c.origin}/#org` },
  };
  return ldJson({ '@context': 'https://schema.org', '@graph': [org, website, app] });
}

/**
 * Sitemap for the marketing site: the indexable (built) pages, one entry per locale,
 * each with xhtml:link hreflang alternates. Referenced from the origin sitemap index.
 */
export function buildSiteSitemapXml(origin: string, locales: LocaleSet): string {
  const built = NAV_PAGES.filter((p) => p.built && !p.noindex);
  const urls: string[] = [];
  for (const page of built) {
    for (const code of locales.codes) {
      const links = [
        ...locales.codes.map(
          (alt) =>
            `    <xhtml:link rel="alternate" hreflang="${xml(alt)}" href="${xml(`${origin}${pagePath(alt, page)}`)}"/>`,
        ),
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(`${origin}${pagePath(locales.default, page)}`)}"/>`,
      ].join('\n');
      urls.push(
        `  <url>\n    <loc>${xml(`${origin}${pagePath(code, page)}`)}</loc>\n${links}\n  </url>`,
      );
    }
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    `${urls.join('\n')}\n</urlset>\n`
  );
}

export { HOME };
