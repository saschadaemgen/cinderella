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
import { DEFAULT_EMBED_SETTINGS, type EmbedSettings } from '../../db/embeds.js';
import type { ArchiveType, PublicFilters, PublicItem } from '../../db/public-archive.js';
import type { SeoHead } from './seo.js';

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
  /** Fully-resolved SEO head (meta/OG/Twitter/feed/analytics/JSON-LD). */
  seo: SeoHead;
  /** CSP nonce for the inline <style> and <script>. */
  nonce: string;
  /**
   * Version hash of the current view (CCB-S2-006) — the same value the
   * `/embed/:id/state` poll endpoint returns. Embedded on `#stream-list` so the
   * live-update client detects a change without a redundant first fetch. Optional
   * so the fragment path (which renders only the region) can omit it.
   */
  streamHash?: string;
}

/**
 * Live-update poll cadence (CCB-S2-006). "Immediately" for the archive means
 * "within this interval": a recalled item disappears — and a newly published one
 * appears — at most one tick after the change, with no manual refresh. Embedded on
 * `#stream-list` (data-poll) so the client and the docs share one source of truth.
 */
const POLL_INTERVAL_MS = 18000;

/** The subset of the render context the reconcilable stream region needs. */
type StreamRegionCtx = Pick<RenderContext, 'items' | 'filters' | 'basePath' | 'page' | 'pageCount'>;

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

/**
 * Themed CSS — the SimpleGo house palette (CCB-S2-005). Dark is the default via
 * `[data-theme="dark"]`; `:root` is light. Operator accent/bg/text overrides are
 * layered on BOTH themes only when they differ from the built-in default, so an
 * unchanged instance uses the house palette (and the toggle), while a custom accent
 * (e.g. Cinderella-pink) or bg/text still wins. Component rules use `--bg/--fg/…`
 * aliases that resolve through `var()` per theme.
 */
function themeCss(t: EmbedSettings['theme'], layout: EmbedSettings['layout']): string {
  const D = DEFAULT_EMBED_SETTINGS.theme;
  const ov: string[] = [];
  if (t.colorAccent !== D.colorAccent) {
    ov.push(`--accent:${t.colorAccent};--accent-bright:${t.colorAccent}`);
  }
  if (t.colorBackground !== D.colorBackground) {
    ov.push(
      `--bg-deep:${t.colorBackground};` +
        `--bg-dark:color-mix(in srgb, ${t.colorText} 5%, ${t.colorBackground});` +
        `--bg-card:color-mix(in srgb, ${t.colorText} 3%, ${t.colorBackground})`,
    );
  }
  if (t.colorText !== D.colorText) {
    ov.push(
      `--text:${t.colorText};--text-bright:${t.colorText};` +
        `--text-dim:color-mix(in srgb, ${t.colorText} 55%, transparent)`,
    );
  }
  const overrides = ov.length > 0 ? `:root,[data-theme="dark"]{${ov.join(';')}}` : '';
  return `
:root{
  --font:'Source Sans 3','Source Sans Pro',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  --radius:12px;--radius-sm:8px;--radius-lg:16px;--tr:0.3s cubic-bezier(0.4,0,0.2,1);
  --accent:#1A7D5A;--accent-bright:#146B4C;
  --bg-deep:#FAFBFC;--bg-dark:#F0F3F5;--bg-card:rgba(255,255,255,0.92);
  --text:#2C3440;--text-bright:#111827;--text-dim:rgba(44,52,64,0.55);
  --border:rgba(26,125,90,0.12);color-scheme:light;
  --bg:var(--bg-deep);--fg:var(--text);--muted:var(--text-dim);--card:var(--bg-card);
}
[data-theme="dark"]{
  --accent:#45BDD1;--accent-bright:#6DD0DF;
  --bg-deep:#050A12;--bg-dark:#080D18;--bg-card:rgba(10,18,32,0.7);
  --text:#CBD5E1;--text-bright:#E8EDF4;--text-dim:rgba(203,213,225,0.5);
  --border:rgba(69,189,209,0.12);color-scheme:dark;
}
${overrides}
*{box-sizing:border-box}
html{background:var(--bg);transition:background var(--tr),color var(--tr)}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 var(--font);transition:background var(--tr),color var(--tr)}
.wrap{max-width:820px;margin:0 auto;padding:20px 16px}
header.arch{margin-bottom:16px}
.head-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
header.arch h1{font-size:1.5rem;margin:0 0 4px;color:var(--text-bright)}
header.arch p{color:var(--muted);margin:0}
.theme-toggle{flex:none;width:40px;height:40px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--accent);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:var(--tr)}
.theme-toggle:hover{border-color:var(--accent)}
.theme-toggle svg{width:20px;height:20px}
.theme-toggle .sun{display:none}
.theme-toggle .moon{display:block}
[data-theme="dark"] .theme-toggle .sun{display:block}
[data-theme="dark"] .theme-toggle .moon{display:none}
form.filters{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0;padding:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}
form.filters input,form.filters select{padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-dark);color:var(--fg);font-size:.9rem}
form.filters input[type=search]{flex:1;min-width:160px}
form.filters button{padding:8px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
form.filters a.reset{align-self:center;color:var(--muted);font-size:.85rem}
.items{display:${layout === 'grid' ? 'grid' : 'flex'};${layout === 'grid' ? 'grid-template-columns:repeat(auto-fill,minmax(240px,1fr));' : 'flex-direction:column;'}gap:14px;list-style:none;padding:0;margin:0}
.item{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;overflow-wrap:anywhere;transition:var(--tr)}
.item .meta{display:flex;gap:8px;align-items:baseline;font-size:.8rem;color:var(--muted);margin-bottom:6px}
.item .who{font-weight:600;color:var(--text-bright)}
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

/** Sun/moon toggle icons + the no-flash and toggle scripts (all nonce-guarded). */
const THEME_TOGGLE = `<button type="button" id="sg-theme-toggle" class="theme-toggle" aria-label="Toggle theme"><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>`;

const THEME_TOGGLE_SCRIPT = `(function(){var b=document.getElementById('sg-theme-toggle');if(!b)return;function c(t){var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',t==='light'?'#FAFBFD':'#050A12');}b.addEventListener('click',function(){var cur=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';var n=cur==='light'?'dark':'light';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('sg-theme',n);}catch(e){}c(n);});})();`;

/** No-flash theme script — runs in <head> before body paint. `sg-theme` shares the
 * key with the operator's site so the stream and site stay in sync on one origin. */
function noFlashScript(auto: boolean): string {
  return `(function(){try{var t=localStorage.getItem('sg-theme');if(!t&&${auto ? 'true' : 'false'})t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',t==='light'?'#FAFBFD':'#050A12');}}catch(e){}})();`;
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

/**
 * The live-reconcilable region: the item list (or empty state) plus the pager.
 * Rendered inside `#stream-list` on the full page AND returned verbatim by the
 * `/embed/:id/fragment` endpoint (CCB-S2-006), so a poll-triggered refresh swaps
 * exactly this markup. Deliberately free of <head>/theme/scripts — it drops into
 * the already-themed page, and carries only already-consent-gated items.
 */
function renderStreamRegion(ctx: StreamRegionCtx): SafeHtml {
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

  return html`${items} ${pager}`;
}

/**
 * The `/embed/:id/fragment` payload (CCB-S2-006): just {@link renderStreamRegion}
 * as a string, for the live-update client to swap into `#stream-list`. Same
 * consent-gated items as the full page — no head, no scripts.
 */
export function renderStreamFragment(ctx: StreamRegionCtx): string {
  return renderStreamRegion(ctx).toString();
}

/** The single render entry point. Returns a complete HTML document. */
export function renderEmbedPage(ctx: RenderContext): string {
  const css = themeCss(ctx.presentation.theme, ctx.presentation.layout);
  const seo = ctx.seo;
  // SSR initial theme from the instance mode; the visitor toggle (localStorage)
  // overrides on subsequent views. `auto` renders dark and lets the no-flash
  // script honour prefers-color-scheme.
  const mode = ctx.presentation.theme.mode;
  const initialTheme = mode === 'light' ? 'light' : 'dark';
  const themeColor = initialTheme === 'light' ? '#FAFBFD' : '#050A12';

  const region = renderStreamRegion(ctx);

  const body = html`<!doctype html>
    <html lang="en" data-theme="${initialTheme}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="${seo.robots}" />
        <meta name="theme-color" content="${themeColor}" />
        <script nonce="${ctx.nonce}">
          ${raw(noFlashScript(mode === 'auto'))};
        </script>
        <title>${seo.title}</title>
        <meta name="description" content="${seo.description}" />
        ${seo.keywords ? html`<meta name="keywords" content="${seo.keywords}" />` : null}
        <link rel="canonical" href="${seo.canonicalUrl}" />
        ${
          seo.feedUrl
            ? html`<link
                rel="alternate"
                type="application/rss+xml"
                title="${seo.ogSiteName}"
                href="${seo.feedUrl}"
              />`
            : null
        }
        <meta property="og:type" content="${seo.ogType}" />
        <meta property="og:title" content="${seo.ogTitle}" />
        <meta property="og:description" content="${seo.ogDescription}" />
        <meta property="og:site_name" content="${seo.ogSiteName}" />
        <meta property="og:locale" content="${seo.ogLocale}" />
        <meta property="og:url" content="${seo.ogUrl}" />
        ${seo.ogImageUrl ? html`<meta property="og:image" content="${seo.ogImageUrl}" />` : null}
        <meta name="twitter:card" content="${seo.twitterCard}" />
        ${seo.twitterSite ? html`<meta name="twitter:site" content="${seo.twitterSite}" />` : null}
        <meta name="twitter:title" content="${seo.ogTitle}" />
        <meta name="twitter:description" content="${seo.ogDescription}" />
        ${seo.twitterImageUrl ? html`<meta name="twitter:image" content="${seo.twitterImageUrl}" />` : null}
        ${
          seo.jsonLd
            ? html`<script type="application/ld+json" nonce="${ctx.nonce}">
                ${raw(seo.jsonLd)}
              </script>`
            : null
        }
        <style nonce="${ctx.nonce}">
          ${raw(css)}
        </style>
        ${
          seo.analyticsScriptUrl
            ? html`<script src="${seo.analyticsScriptUrl}" async></script>`
            : null
        }
      </head>
      <body>
        <div class="wrap">
          <header class="arch">
            <div class="head-row">
              <div>
                <h1>${seo.title}</h1>
                <p>${seo.description}</p>
              </div>
              ${raw(THEME_TOGGLE)}
            </div>
          </header>
          ${filterBar(ctx)}
          <div id="stream-list" data-hash="${ctx.streamHash ?? ''}" data-poll="${POLL_INTERVAL_MS}">
            ${region}
          </div>
          <footer class="arch">
            Published with consent · powered by
            <a href="https://github.com/saschadaemgen/cinderella" target="_blank" rel="noopener"
              >Cinderella</a
            >
          </footer>
        </div>
        <script nonce="${ctx.nonce}">
          ${raw(HEIGHT_SCRIPT)};
        </script>
        <script nonce="${ctx.nonce}">
          ${raw(THEME_TOGGLE_SCRIPT)};
        </script>
        <script nonce="${ctx.nonce}">
          ${raw(LIVE_SCRIPT)};
        </script>
      </body>
    </html>`;

  return body.toString();
}

/** Posts the document height to the embedding parent (Season 1 snippet contract). */
const HEIGHT_SCRIPT = `(function(){function h(){try{parent.postMessage({cinderellaEmbedHeight:document.documentElement.scrollHeight},'*')}catch(e){}}addEventListener('load',h);addEventListener('resize',h);if(window.ResizeObserver){new ResizeObserver(h).observe(document.documentElement)}h()})();`;

/**
 * Live-update client (CCB-S2-006) — consent-gated polling, progressive
 * enhancement. Polls `/embed/:id/state` (cheap ids+hash for the SAME URL filters
 * as this page); on a hash change it fetches the rendered `/embed/:id/fragment`
 * and swaps `#stream-list` — so a recalled item disappears and a newly published
 * one appears with no manual refresh. Both fetches are same-origin (CSP
 * connect-src 'self') and consent-gated server-side; the client never sees
 * unpublished ids. Re-posts the iframe height after any swap, and pauses entirely
 * while the tab is hidden (resuming — with an immediate tick — on focus).
 */
const LIVE_SCRIPT = `(function(){var el=document.getElementById('stream-list');if(!el||!window.fetch)return;var poll=Math.max(8000,parseInt(el.getAttribute('data-poll'),10)||18000);var hash=el.getAttribute('data-hash')||'';var base=location.pathname.replace(/\\/+$/,'');var qs=location.search;var busy=false,timer=null;function height(){try{parent.postMessage({cinderellaEmbedHeight:document.documentElement.scrollHeight},'*')}catch(e){}}function refresh(){fetch(base+'/fragment'+qs,{credentials:'omit'}).then(function(r){return r.ok?r.text():null}).then(function(t){if(t!=null){el.innerHTML=t;height()}}).catch(function(){})}function tick(){if(busy||document.hidden)return;busy=true;fetch(base+'/state'+qs,{credentials:'omit',headers:{accept:'application/json'}}).then(function(r){return r.ok?r.json():null}).then(function(s){busy=false;if(s&&typeof s.hash==='string'&&s.hash!==hash){hash=s.hash;refresh()}}).catch(function(){busy=false})}function start(){if(!timer)timer=setInterval(tick,poll)}function stop(){if(timer){clearInterval(timer);timer=null}}document.addEventListener('visibilitychange',function(){if(document.hidden){stop()}else{start();tick()}});if(!document.hidden)start()})();`;

/** Compact UTC timestamp for display (deterministic, locale-independent). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
