/**
 * Public archive presentation layer (CCB-S2-003).
 *
 * The SINGLE render entry point ({@link renderEmbedPage}) takes a fully-resolved
 * {@link RenderContext} — the instance's presentation config plus the already
 * consent-gated data — and returns server-side-rendered HTML. Content is rendered
 * into the markup here (NOT deferred to client JS) so search engines index the
 * real text: this is the SEO foundation.
 *
 * Extensibility seams (kept deliberately clean so later briefings slot in):
 *  - `PresentationConfig.template` — template selection (CCB-S2-005).
 *  - design-editor overrides (CCB-S2-006) layer onto `PresentationConfig`.
 *  - the SEO `@graph` is an array, so CCB-S2-004 appends schema types without a
 *    rewrite.
 *
 * The page is self-contained (no external CSS/JS): themed CSS and a tiny
 * iframe-height script are inlined under a per-response CSP nonce.
 */

import { html, raw, type SafeHtml } from '../html.js';
import type { EmbedSettings } from '../../db/embeds.js';
import type { ArchiveType, PublicFilters, PublicItem } from '../../db/public-archive.js';

export interface PresentationConfig {
  /** Template id — only 'default' today; CCB-S2-005 adds more. */
  template: 'default';
  theme: EmbedSettings['theme'];
  layout: EmbedSettings['layout'];
}

export interface RenderContext {
  presentation: PresentationConfig;
  /** Enabled visitor-facing filters (from the instance). */
  enabledFilters: EmbedSettings['filters'];
  /** Active filter/search state (drives the form + canonical URL). */
  filters: PublicFilters;
  items: PublicItem[];
  total: number;
  page: number;
  pageCount: number;
  /** `${origin}/embed/${id}` — base for links, media, canonical. */
  basePath: string;
  origin: string;
  canonicalUrl: string;
  ogImageUrl: string | null;
  title: string;
  description: string;
  /** CSP nonce for the inline <style> and <script>. */
  nonce: string;
}

/** Builds a query string from the active filters, with overrides (e.g. page). */
function queryString(f: PublicFilters, overrides: Partial<PublicFilters> = {}): string {
  const m = { ...f, ...overrides };
  const parts: string[] = [];
  if (m.type) parts.push(`type=${encodeURIComponent(m.type)}`);
  if (m.since) parts.push(`since=${encodeURIComponent(m.since)}`);
  if (m.until) parts.push(`until=${encodeURIComponent(m.until)}`);
  if (m.q) parts.push(`q=${encodeURIComponent(m.q)}`);
  if (m.page && m.page > 1) parts.push(`page=${m.page}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

const TYPE_LABELS: Record<ArchiveType, string> = {
  text: 'Text',
  image: 'Images',
  video: 'Video',
  voice: 'Voice',
  link: 'Links',
  file: 'Files',
};

/** Themed CSS, built from validated hex colors (safe to inline). */
function themeCss(t: EmbedSettings['theme'], layout: EmbedSettings['layout']): string {
  // Use the operator's exact colours; derive muted/card/border from them with
  // color-mix so any palette (light OR dark) stays coherent. `mode` sets
  // color-scheme (native controls); `auto` lets the browser follow the OS.
  const scheme = t.mode === 'auto' ? 'light dark' : t.mode;
  return `
:root{
  --bg:${t.colorBackground};--fg:${t.colorText};--accent:${t.colorAccent};
  --muted:color-mix(in srgb, var(--fg) 55%, var(--bg));
  --card:color-mix(in srgb, var(--fg) 4%, var(--bg));
  --border:color-mix(in srgb, var(--fg) 14%, var(--bg));
  --radius:12px;color-scheme:${scheme}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:20px 16px}
header.arch{margin-bottom:16px}
header.arch h1{font-size:1.5rem;margin:0 0 4px}
header.arch p{color:var(--muted);margin:0}
form.filters{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0;padding:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}
form.filters input,form.filters select{padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font-size:.9rem}
form.filters input[type=search]{flex:1;min-width:160px}
form.filters button{padding:8px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
form.filters a.reset{align-self:center;color:var(--muted);font-size:.85rem}
.items{display:${layout === 'grid' ? 'grid' : 'flex'};${layout === 'grid' ? 'grid-template-columns:repeat(auto-fill,minmax(240px,1fr));' : 'flex-direction:column;'}gap:14px;list-style:none;padding:0;margin:0}
.item{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;overflow-wrap:anywhere}
.item .meta{display:flex;gap:8px;align-items:baseline;font-size:.8rem;color:var(--muted);margin-bottom:6px}
.item .who{font-weight:600;color:var(--fg)}
.item .body{white-space:pre-wrap;margin:0}
.item img.media{max-width:100%;height:auto;border-radius:8px;margin-top:8px;display:block}
.item .filelink{display:inline-block;margin-top:8px;color:var(--accent);font-weight:600;text-decoration:none}
.item .links{margin:8px 0 0;padding:0;list-style:none}
.item .links a{color:var(--accent)}
.pager{display:flex;justify-content:space-between;align-items:center;margin:20px 0;color:var(--muted);font-size:.9rem}
.pager a{color:var(--accent);font-weight:600;text-decoration:none}
.empty{color:var(--muted);text-align:center;padding:40px 0}
footer.arch{margin-top:24px;color:var(--muted);font-size:.8rem;text-align:center}
a{color:var(--accent)}
`.trim();
}

/** Renders one published item's media/body into the card. */
function itemMedia(it: PublicItem, mediaUrl: string): SafeHtml {
  if (it.type === 'image' && it.hasMedia) {
    return html`<img
      class="media"
      src="${mediaUrl}"
      alt="Image from ${it.senderDisplayName}"
      loading="lazy"
    />`;
  }
  if (it.hasMedia && (it.type === 'video' || it.type === 'voice' || it.type === 'file')) {
    const label =
      it.type === 'video' ? 'Open video' : it.type === 'voice' ? 'Play voice' : 'Download file';
    return html`<a class="filelink" href="${mediaUrl}" rel="noopener">${label} →</a>`;
  }
  return html``;
}

function itemLinks(it: PublicItem): SafeHtml {
  if (it.links.length === 0) return html``;
  return html`<ul class="links">
    ${it.links.map(
      (l) =>
        html`<li>
          <a href="${l.url}" rel="nofollow noopener" target="_blank">${l.title ?? l.url}</a>
        </li>`,
    )}
  </ul>`;
}

/** schema.org JSON-LD `@graph`. An array so CCB-S2-004 appends more types. */
function jsonLd(ctx: RenderContext): string {
  const graph: unknown[] = [
    {
      '@type': 'WebSite',
      '@id': `${ctx.origin}/#website`,
      name: ctx.title,
      url: ctx.basePath,
      description: ctx.description,
    },
    {
      '@type': 'Organization',
      '@id': `${ctx.origin}/#org`,
      name: 'Cinderella',
      url: ctx.origin,
    },
    {
      '@type': 'ItemList',
      itemListOrder: 'https://schema.org/ItemListOrderDescending',
      numberOfItems: ctx.total,
      itemListElement: ctx.items.map((it, i) => ({
        '@type': 'ListItem',
        position: (ctx.page - 1) * ctx.filters.pageSize + i + 1,
        item: {
          '@type': 'DiscussionForumPosting',
          '@id': `${ctx.basePath}#msg-${it.id}`,
          url: `${ctx.basePath}#msg-${it.id}`,
          datePublished: it.sentAt,
          author: { '@type': 'Person', name: it.senderDisplayName },
          text: it.textBody ?? undefined,
          ...(it.type === 'image' && it.hasMedia
            ? { image: `${ctx.basePath}/media/${it.id}` }
            : {}),
          isPartOf: { '@id': `${ctx.origin}/#website` },
        },
      })),
    },
  ];
  const payload = { '@context': 'https://schema.org', '@graph': graph };
  // Escape `<` so a text field can never break out of the <script> element.
  return JSON.stringify(payload).replace(/</g, '\\u003c');
}

/** The SSR filter/search bar (only the enabled controls). */
function filterBar(ctx: RenderContext): SafeHtml {
  const { enabledFilters: ef, filters: f } = ctx;
  if (!ef.byType && !ef.byTime && !ef.search) return html``;
  const typeOptions: [string, string][] = [['', 'All types'], ...ARCHIVE_TYPE_ENTRIES];
  return html`<form class="filters" method="get" action="${ctx.basePath}">
    ${
      ef.search
        ? html`<input
            type="search"
            name="q"
            value="${f.q ?? ''}"
            placeholder="Search the archive…"
            aria-label="Search"
          />`
        : null
    }
    ${
      ef.byType
        ? html`<select name="type" aria-label="Type">
            ${typeOptions.map(
              ([v, label]) =>
                html`<option value="${v}" ${v === (f.type ?? '') ? raw('selected') : ''}>
                  ${label}
                </option>`,
            )}
          </select>`
        : null
    }
    ${
      ef.byTime
        ? html`<input type="date" name="since" value="${f.since ?? ''}" aria-label="From date" />
            <input type="date" name="until" value="${f.until ?? ''}" aria-label="Until date" />`
        : null
    }
    <button type="submit">Filter</button>
    ${
      f.type || f.since || f.until || f.q
        ? html`<a class="reset" href="${ctx.basePath}">Reset</a>`
        : null
    }
  </form>`;
}

const ARCHIVE_TYPE_ENTRIES: [string, string][] = Object.entries(TYPE_LABELS);

/** The single render entry point. Returns a complete HTML document. */
export function renderEmbedPage(ctx: RenderContext): string {
  const css = themeCss(ctx.presentation.theme, ctx.presentation.layout);
  const ld = jsonLd(ctx);

  const items =
    ctx.items.length > 0
      ? html`<ul class="items">
          ${ctx.items.map(
            (it) =>
              html`<li class="item" id="msg-${it.id}">
                <div class="meta">
                  <span class="who">${it.senderDisplayName}</span>
                  <time datetime="${it.sentAt}">${fmtTime(it.sentAt)}</time>
                </div>
                ${it.textBody ? html`<p class="body">${it.textBody}</p>` : html``}
                ${itemMedia(it, `${ctx.basePath}/media/${it.id}`)} ${itemLinks(it)}
              </li>`,
          )}
        </ul>`
      : html`<p class="empty">No published messages match this view yet.</p>`;

  const pager =
    ctx.pageCount > 1
      ? html`<nav class="pager" aria-label="Pagination">
          <span>Page ${ctx.page} of ${ctx.pageCount}</span>
          <span>
            ${
              ctx.page > 1
                ? html`<a
                    rel="prev"
                    href="${ctx.basePath}${queryString(ctx.filters, { page: ctx.page - 1 })}"
                    >← Newer</a
                  >`
                : null
            }
            ${
              ctx.page < ctx.pageCount
                ? html`<a
                    rel="next"
                    href="${ctx.basePath}${queryString(ctx.filters, { page: ctx.page + 1 })}"
                    >Older →</a
                  >`
                : null
            }
          </span>
        </nav>`
      : html``;

  const body = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="index, follow" />
        <title>${ctx.title}</title>
        <meta name="description" content="${ctx.description}" />
        <link rel="canonical" href="${ctx.canonicalUrl}" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="${ctx.title}" />
        <meta property="og:description" content="${ctx.description}" />
        <meta property="og:url" content="${ctx.canonicalUrl}" />
        ${ctx.ogImageUrl ? html`<meta property="og:image" content="${ctx.ogImageUrl}" />` : null}
        <meta name="twitter:card" content="${ctx.ogImageUrl ? 'summary_large_image' : 'summary'}" />
        <meta name="twitter:title" content="${ctx.title}" />
        <meta name="twitter:description" content="${ctx.description}" />
        ${ctx.ogImageUrl ? html`<meta name="twitter:image" content="${ctx.ogImageUrl}" />` : null}
        <script type="application/ld+json" nonce="${ctx.nonce}">
          ${raw(ld)}
        </script>
        <style nonce="${ctx.nonce}">
          ${raw(css)}
        </style>
      </head>
      <body>
        <div class="wrap">
          <header class="arch">
            <h1>${ctx.title}</h1>
            <p>${ctx.description}</p>
          </header>
          ${filterBar(ctx)} ${items} ${pager}
          <footer class="arch">Published with consent · powered by Cinderella</footer>
        </div>
        <script nonce="${ctx.nonce}">
          ${raw(HEIGHT_SCRIPT)};
        </script>
      </body>
    </html>`;

  return body.toString();
}

/** Posts the document height to the embedding parent (Season 1 snippet contract). */
const HEIGHT_SCRIPT = `(function(){function h(){try{parent.postMessage({cinderellaEmbedHeight:document.documentElement.scrollHeight},'*')}catch(e){}}addEventListener('load',h);addEventListener('resize',h);if(window.ResizeObserver){new ResizeObserver(h).observe(document.documentElement)}h()})();`;

/** Compact UTC timestamp for display (deterministic, locale-independent). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
