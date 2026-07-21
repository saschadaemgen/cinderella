/**
 * The marketing site's page catalog (CCB-S2-012) — a single source of truth shared
 * by routing, navigation, SEO and the sitemap. Home is built; the rest are clean
 * stubs (rendered "coming soon", never a 404). Adding a real page later = flip
 * `built` and give it a body in render.ts.
 *
 * A page's i18n meta keys are `meta.<key>.title` / `meta.<key>.description`, and its
 * nav label is the `navKey` string id. The URL is `/<locale>` for home and
 * `/<locale>/<slug>` otherwise.
 */

export interface SitePage {
  /** Stable id; also the `meta.<key>.*` prefix. */
  key: string;
  /** URL slug ('' for home). */
  slug: string;
  /** i18n key for the nav label. */
  navKey: string;
  /** Whether a real page exists (else a stub is rendered). */
  built: boolean;
}

export const HOME: SitePage = { key: 'home', slug: '', navKey: 'nav.home', built: true };

export const STUB_PAGES: SitePage[] = [
  { key: 'suite', slug: 'suite', navKey: 'nav.suite', built: false },
  { key: 'pro', slug: 'pro', navKey: 'nav.pro', built: false },
  { key: 'security', slug: 'security', navKey: 'nav.security', built: false },
  { key: 'open-source', slug: 'open-source', navKey: 'nav.opensource', built: false },
  { key: 'docs', slug: 'docs', navKey: 'nav.docs', built: false },
  { key: 'legal', slug: 'legal', navKey: 'nav.legal', built: false },
];

/** Nav order: Home first, then the stubs. */
export const NAV_PAGES: SitePage[] = [HOME, ...STUB_PAGES];

const BY_SLUG = new Map(STUB_PAGES.map((p) => [p.slug, p]));

/** Look up a stub page by slug (home has no slug). */
export function pageBySlug(slug: string): SitePage | undefined {
  return BY_SLUG.get(slug);
}

/** The path for a page in a locale — `/en` for home, `/en/suite` otherwise. */
export function pagePath(locale: string, page: SitePage): string {
  return page.slug ? `/${locale}/${page.slug}` : `/${locale}`;
}
