/**
 * SEO & marketing artifact builders (CCB-S2-004).
 *
 * Every builder here consumes ALREADY consent-gated data (published items, from
 * `published_messages`) — nothing widens the gate (D-016). All are driven off the
 * instance's `seo` config so the render path stays single (D-015): templates
 * (CCB-S2-005) and the design editor (CCB-S2-006) keep plugging into the same seam.
 *
 * Builders: resolveSeoHead (meta/OG/Twitter/feed/analytics), buildJsonLd (the full
 * schema.org @graph, toggle-driven), buildSitemapXml / buildSitemapIndexXml,
 * buildFeedXml (RSS 2.0), buildRobotsTxt, buildOgSvg (auto social image).
 */

import type { EmbedInstance, SeoSettings } from '../../db/embeds.js';
import type { ArchiveType, PublicFilters, PublicItem } from '../../db/public-archive.js';

// ---------- escaping ----------

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
/** JSON for a <script type="application/ld+json"> — escape `<` so text can't break out. */
function ldJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

const TYPE_LABELS: Record<ArchiveType, string> = {
  text: 'Text',
  image: 'Images',
  video: 'Video',
  voice: 'Voice',
  link: 'Links',
  file: 'Files',
};

/** Human "section" for the title template, from the active filters. */
function section(f: PublicFilters): string {
  if (f.q) return `Search “${f.q}”`;
  if (f.type) return TYPE_LABELS[f.type];
  if (f.page > 1) return `Page ${f.page}`;
  return '';
}

// ---------- resolved head ----------

export interface SeoHead {
  title: string;
  description: string;
  keywords: string;
  robots: string;
  canonicalUrl: string;
  ogTitle: string;
  ogDescription: string;
  ogType: string;
  ogSiteName: string;
  ogLocale: string;
  ogUrl: string;
  ogImageUrl: string;
  twitterCard: string;
  twitterSite: string;
  twitterImageUrl: string;
  /** rel=alternate feed URL ('' → omit). */
  feedUrl: string;
  /** External analytics script ('' → omit; also gates the CSP allowance). */
  analyticsScriptUrl: string;
  /** Serialized JSON-LD @graph ('' → omit). */
  jsonLd: string;
  /** `<link rel=prev>` for the previous crawlable page ('' → omit; CCB-S2-007). */
  prevUrl: string;
  /** `<link rel=next>` for the next crawlable page ('' → omit; CCB-S2-007). */
  nextUrl: string;
}

export interface SeoContext {
  instance: EmbedInstance;
  seo: SeoSettings;
  filters: PublicFilters;
  items: PublicItem[];
  total: number;
  origin: string;
  /** `${origin}/embed/${id}`. */
  basePath: string;
  /** Canonical URL for the current view (already includes active query). */
  canonicalUrl: string;
  /** Latest published image id for default preview imagery (or null). */
  ogImageId: number | null;
  /** Current page (1-based) for rel=prev/next (CCB-S2-007). */
  page: number;
  /** Total pages for rel=prev/next (CCB-S2-007). */
  pageCount: number;
}

/** A crawlable `?page=N` URL for the active filters (drops page=1), origin-based. */
function pageUrl(basePath: string, f: PublicFilters, page: number): string {
  const parts: string[] = [];
  if (f.type) parts.push(`type=${encodeURIComponent(f.type)}`);
  if (f.since) parts.push(`since=${encodeURIComponent(f.since)}`);
  if (f.until) parts.push(`until=${encodeURIComponent(f.until)}`);
  if (f.q) parts.push(`q=${encodeURIComponent(f.q)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length > 0 ? `${basePath}?${parts.join('&')}` : basePath;
}

const DEFAULT_DESCRIPTION =
  'A consent-first public archive — only messages members chose to publish. ' +
  'Searchable and permanent.';

export function resolveSeoHead(c: SeoContext): SeoHead {
  const { seo } = c;
  const sec = section(c.filters);
  const title =
    (seo.titleTemplate || '{instance}{section}')
      .replaceAll('{instance}', c.instance.name || 'Community Archive')
      .replaceAll('{section}', sec ? ` — ${sec}` : '')
      .trim() ||
    c.instance.name ||
    'Community Archive';
  const description = seo.description.trim() || DEFAULT_DESCRIPTION;

  // Canonical honours the operator's base override, else the deployment origin.
  const applyBase = (u: string): string =>
    seo.canonicalBase ? u.replace(c.origin, seo.canonicalBase.replace(/\/+$/, '')) : u;
  const canonicalUrl = applyBase(c.canonicalUrl);

  // rel=prev/next for crawlable deep pages (CCB-S2-007) — same canonicalBase as the
  // canonical, omitted at the edges and entirely when the instance is noindex.
  // Both gated to the real page range so an out-of-range `?page=N` (up to MAX_PAGE)
  // emits NEITHER link — no descending chain of empty duplicate pages for crawlers.
  const noindex = /noindex/i.test(seo.robots);
  const inRange = c.page >= 1 && c.page <= c.pageCount;
  const prevUrl =
    !noindex && inRange && c.page > 1 ? applyBase(pageUrl(c.basePath, c.filters, c.page - 1)) : '';
  const nextUrl =
    !noindex && inRange && c.page < c.pageCount
      ? applyBase(pageUrl(c.basePath, c.filters, c.page + 1))
      : '';

  const ogImageUrl =
    seo.og.imageUrl ||
    (seo.og.autoImage
      ? `${c.basePath}/og.png`
      : c.ogImageId != null
        ? `${c.basePath}/media/${c.ogImageId}`
        : '');

  const jsonLd = buildJsonLd(c, title, description);

  return {
    title,
    description,
    keywords: seo.keywords.trim(),
    robots: seo.robots,
    canonicalUrl,
    ogTitle: title,
    ogDescription: description,
    ogType: seo.og.type,
    ogSiteName: seo.og.siteName,
    ogLocale: seo.og.locale,
    ogUrl: canonicalUrl,
    ogImageUrl,
    twitterCard: ogImageUrl ? 'summary_large_image' : 'summary',
    twitterSite: seo.og.twitterSite,
    twitterImageUrl: ogImageUrl,
    feedUrl: seo.feed.enabled ? `${c.basePath}/feed.xml` : '',
    analyticsScriptUrl: seo.analytics.scriptUrl,
    jsonLd,
    prevUrl,
    nextUrl,
  };
}

// ---------- JSON-LD @graph ----------

function postingNode(c: SeoContext, it: PublicItem, type: string): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': type,
    '@id': `${c.basePath}#msg-${it.id}`,
    url: `${c.basePath}#msg-${it.id}`,
    datePublished: it.sentAt,
    author: { '@type': 'Person', name: it.senderDisplayName },
    isPartOf: { '@id': `${c.origin}/#website` },
  };
  if (it.textBody) node['text'] = it.textBody;
  if (c.seo.jsonld.media && it.hasMedia) {
    const mediaUrl = `${c.basePath}/media/${it.id}`;
    if (it.type === 'image') {
      node['image'] = { '@type': 'ImageObject', url: mediaUrl, contentUrl: mediaUrl };
    } else if (it.type === 'video') {
      node['video'] = {
        '@type': 'VideoObject',
        name: `Video from ${it.senderDisplayName}`,
        contentUrl: mediaUrl,
        uploadDate: it.sentAt,
      };
    }
  }
  return node;
}

export function buildJsonLd(c: SeoContext, title: string, description: string): string {
  const j = c.seo.jsonld;
  const graph: unknown[] = [];

  if (j.website) {
    graph.push({
      '@type': 'WebSite',
      '@id': `${c.origin}/#website`,
      name: title,
      url: c.basePath,
      description,
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${c.basePath}?q={search_term_string}` },
        'query-input': 'required name=search_term_string',
      },
    });
  }

  if (j.organization) {
    const org: Record<string, unknown> = {
      '@type': 'Organization',
      '@id': `${c.origin}/#org`,
      name: c.seo.org.name || 'Cinderella',
      url: c.seo.org.url || c.origin,
    };
    if (c.seo.org.logoUrl) org['logo'] = c.seo.org.logoUrl;
    const sameAs = c.seo.org.sameAs
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => /^https:\/\//.test(s));
    if (sameAs.length > 0) org['sameAs'] = sameAs;
    graph.push(org);
  }

  const postings = j.postings ? c.items.map((it) => postingNode(c, it, j.postingType)) : [];

  if (j.itemList) {
    graph.push({
      '@type': 'CollectionPage',
      '@id': `${c.canonicalUrl}#page`,
      name: title,
      description,
      url: c.canonicalUrl,
      isPartOf: j.website ? { '@id': `${c.origin}/#website` } : undefined,
      breadcrumb: {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: c.instance.name, item: c.basePath },
          ...(section(c.filters)
            ? [{ '@type': 'ListItem', position: 2, name: section(c.filters), item: c.canonicalUrl }]
            : []),
        ],
      },
      mainEntity: {
        '@type': 'ItemList',
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        numberOfItems: c.total,
        itemListElement: postings.map((p, i) => ({
          '@type': 'ListItem',
          position: (c.filters.page - 1) * c.filters.pageSize + i + 1,
          item: p,
        })),
      },
    });
  } else if (j.postings) {
    // Postings without an ItemList → top-level graph nodes.
    graph.push(...postings);
  }

  if (graph.length === 0) return '';
  return ldJson({ '@context': 'https://schema.org', '@graph': graph });
}

// ---------- sitemap ----------

export interface SitemapContext {
  seo: SeoSettings;
  basePath: string;
  canonicalBasePath: string;
  total: number;
  pageSize: number;
  enabledTypes: readonly ArchiveType[];
  enabledFilters: { byType: boolean };
  lastmod: string | null;
}

/** Per-instance sitemap. Empty (valid) urlset when the instance is noindex. */
export function buildSitemapXml(s: SitemapContext): string {
  const urls: { loc: string; lastmod: string | null }[] = [];
  const noindex = /noindex/i.test(s.seo.robots);
  if (!noindex) {
    urls.push({ loc: s.canonicalBasePath, lastmod: s.lastmod });
    const pages = Math.max(1, Math.ceil(s.total / s.pageSize));
    for (let p = 2; p <= pages; p++)
      urls.push({ loc: `${s.canonicalBasePath}?page=${p}`, lastmod: s.lastmod });
    if (s.enabledFilters.byType) {
      for (const t of s.enabledTypes)
        urls.push({ loc: `${s.canonicalBasePath}?type=${t}`, lastmod: s.lastmod });
    }
  }
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${xml(u.loc)}</loc>` +
        (u.lastmod ? `\n    <lastmod>${xml(u.lastmod)}</lastmod>` : '') +
        `\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** Root sitemap index: the marketing-site sitemap (CCB-S2-012) + every instance's. */
export function buildSitemapIndexXml(instanceIds: string[], origin: string): string {
  const locs = [
    `${origin}/sitemap-site.xml`,
    ...instanceIds.map((id) => `${origin}/embed/${id}/sitemap.xml`),
  ];
  const body = locs
    .map((loc) => `  <sitemap>\n    <loc>${xml(loc)}</loc>\n  </sitemap>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

// ---------- RSS feed ----------

export interface FeedContext {
  instance: EmbedInstance;
  items: PublicItem[];
  basePath: string;
  title: string;
  description: string;
  lastmod: string | null;
}

function snippet(it: PublicItem): string {
  if (it.textBody) return it.textBody.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${it.type} from ${it.senderDisplayName}`;
}

/** RSS 2.0 feed of published items (already consent-gated). */
export function buildFeedXml(f: FeedContext): string {
  const items = f.items
    .map((it) => {
      const link = `${f.basePath}#msg-${it.id}`;
      const desc = it.textBody ?? `${it.type} from ${it.senderDisplayName}`;
      return (
        `    <item>\n` +
        `      <title>${xml(snippet(it))}</title>\n` +
        `      <link>${xml(link)}</link>\n` +
        `      <guid isPermaLink="false">${xml(`${f.instance.id}:${it.id}`)}</guid>\n` +
        `      <dc:creator>${xml(it.senderDisplayName)}</dc:creator>\n` +
        `      <pubDate>${new Date(it.sentAt).toUTCString()}</pubDate>\n` +
        `      <description>${xml(desc)}</description>\n` +
        `    </item>`
      );
    })
    .join('\n');
  const built = f.lastmod ? new Date(f.lastmod).toUTCString() : new Date(0).toUTCString();
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `  <channel>\n` +
    `    <title>${xml(f.title)}</title>\n` +
    `    <link>${xml(f.basePath)}</link>\n` +
    `    <description>${xml(f.description)}</description>\n` +
    `    <lastBuildDate>${built}</lastBuildDate>\n` +
    `    <atom:link href="${xml(`${f.basePath}/feed.xml`)}" rel="self" type="application/rss+xml" />\n` +
    `${items}\n` +
    `  </channel>\n` +
    `</rss>\n`
  );
}

// ---------- robots.txt ----------

/** Admin surfaces that must never be indexed (CCB-S2-012 opened the root to the
 * public marketing site, so the root can no longer be blanket-disallowed). */
const ADMIN_DISALLOW = [
  '/login',
  '/logout',
  '/dashboard',
  '/messages',
  '/consent',
  '/settings',
  '/security',
  '/embeds',
  '/website',
  '/reports',
  '/webauthn/',
  '/healthz',
];

/** Origin robots.txt: allow the public marketing site + archive front, disallow the
 * admin console, point at the sitemap index. Never lists a non-published path. */
export function buildRobotsTxt(origin: string): string {
  const disallow = ADMIN_DISALLOW.map((p) => `Disallow: ${p}`).join('\n');
  return (
    `User-agent: *\n` + `Allow: /\n` + `${disallow}\n` + `\n` + `Sitemap: ${origin}/sitemap.xml\n`
  );
}

// ---------- auto OG image ----------

/** A 1200×630 social-preview SVG (rasterized to PNG by the route via sharp). */
export function buildOgSvg(title: string, siteName: string, accent: string): string {
  const t = title.length > 70 ? `${title.slice(0, 68)}…` : title;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
    `<rect width="1200" height="630" fill="#0b1220"/>` +
    `<rect width="1200" height="10" fill="${xml(accent)}"/>` +
    `<text x="80" y="300" font-family="Segoe UI, Roboto, sans-serif" font-size="64" font-weight="700" fill="#f8fafc">${xml(t)}</text>` +
    `<text x="80" y="380" font-family="Segoe UI, Roboto, sans-serif" font-size="32" fill="#94a3b8">${xml(siteName)}</text>` +
    `<text x="80" y="560" font-family="Segoe UI, Roboto, sans-serif" font-size="26" fill="${xml(accent)}">Published with consent · Cinderella</text>` +
    `</svg>`
  );
}
