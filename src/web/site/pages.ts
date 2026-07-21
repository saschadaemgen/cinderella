/**
 * The marketing site's page catalog (CCB-S2-012, redesigned CCB-S3-001) — a single
 * source of truth shared by routing, navigation, SEO and the sitemap. All template
 * pages are built; Docs remains a clean "coming soon" stub (never a 404).
 *
 * A page's i18n meta keys are `meta.<key>.title` / `meta.<key>.description`, and its
 * nav label is the `navKey` string id. The URL is `/<locale>` for home and
 * `/<locale>/<slug>` otherwise. The legal sub-pages (privacy/terms) carry a
 * two-segment slug and are routed explicitly (see routes.ts); they are `noindex`
 * while their texts are drafts pending the planning chat's final versions.
 */

export interface SitePage {
  /** Stable id; also the `meta.<key>.*` prefix. */
  key: string;
  /** URL slug ('' for home; may contain '/' for legal sub-pages). */
  slug: string;
  /** i18n key for the nav label. */
  navKey: string;
  /** Whether a real page exists (else a stub is rendered). */
  built: boolean;
  /** Built but thin/draft content — noindex, excluded from the sitemap. */
  noindex?: boolean;
}

export const HOME: SitePage = { key: 'home', slug: '', navKey: 'nav.home', built: true };

export const SITE_PAGES: SitePage[] = [
  { key: 'features', slug: 'features', navKey: 'nav.features', built: true },
  { key: 'pro', slug: 'pro', navKey: 'nav.pro', built: true },
  { key: 'security', slug: 'security', navKey: 'nav.security', built: true },
  { key: 'open-source', slug: 'open-source', navKey: 'nav.opensource', built: true },
  { key: 'docs', slug: 'docs', navKey: 'nav.docs', built: false },
  { key: 'legal', slug: 'legal', navKey: 'nav.legal', built: true },
  // Draft legal texts (CCB-S3-001): reachable + rendered, but noindex until the
  // planning chat delivers the final Privacy/Terms texts.
  { key: 'legal-privacy', slug: 'legal/privacy', navKey: 'nav.legal', built: true, noindex: true },
  { key: 'legal-terms', slug: 'legal/terms', navKey: 'nav.legal', built: true, noindex: true },
];

/** Nav order: Home first, then the template's main pages (legal sub-pages excluded). */
export const NAV_PAGES: SitePage[] = [HOME, ...SITE_PAGES.filter((p) => !p.slug.includes('/'))];

const BY_SLUG = new Map(SITE_PAGES.map((p) => [p.slug, p]));

/** Look up a page by slug (home has no slug; legal sub-pages use 'legal/privacy' …). */
export function pageBySlug(slug: string): SitePage | undefined {
  return BY_SLUG.get(slug);
}

/** The path for a page in a locale — `/en` for home, `/en/features` otherwise. */
export function pagePath(locale: string, page: SitePage): string {
  return page.slug ? `/${locale}/${page.slug}` : `/${locale}`;
}
