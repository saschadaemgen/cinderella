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
import { THEME_TOGGLE, THEME_TOGGLE_SCRIPT, THEME_VARS_CSS, themeBootScript } from '../theme.js';
import { DEFAULT_EMBED_SETTINGS, type EmbedSettings } from '../../db/embeds.js';
import type { ArchiveType, PublicFilters, PublicItem } from '../../db/public-archive.js';
import type { SeoHead } from './seo.js';

export interface PresentationConfig {
  /** Template id — only 'default' today; CCB-S2-005 adds more. */
  template: 'default';
  theme: EmbedSettings['theme'];
  layout: EmbedSettings['layout'];
}

/** Per-instance video-card behaviour, threaded to the card renderer. */
export interface VideoCardOpts {
  /** When off, a video link renders as a plain link. */
  embed: boolean;
  /** Enabled provider keys; a link whose provider is not here stays a link. */
  providers: string[];
  /** Show the "playing loads content from …" line. */
  showNotice: boolean;
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
  /** Show the media download button + native download control (CCB-S2-008). */
  showDownload: boolean;
  /** Video-card behaviour for this instance (CCB-S3-014). */
  video: VideoCardOpts;
  /**
   * Version hash of the current view (CCB-S2-006) — the same value the
   * `/embed/:id/state` poll endpoint returns. Embedded on `#stream-list` so the
   * live-update client detects a change without a redundant first fetch. Optional
   * so the fragment path (which renders only the region) can omit it.
   */
  streamHash?: string;
  /** Cursor for the next (older) infinite-scroll page (CCB-S2-007); '' when none. */
  nextCursor: string;
  /** Whether older pages exist beyond this SSR page (seeds the bottom sentinel). */
  hasMore: boolean;
  /** DOM windowing cap — max rendered cards the client keeps before trimming. */
  windowCap: number;
  /** Cursor endpoint page size (informational seed for the client). */
  cursorPageSize: number;
  /** True after a report was filed (renders the confirmation banner; CCB-S2-009). */
  reported?: boolean;
}

/**
 * Live-update poll cadence (CCB-S2-006). "Immediately" for the archive means
 * "within this interval": a recalled item disappears — and a newly published one
 * appears — at most one tick after the change, with no manual refresh. Embedded on
 * `#stream-list` (data-poll) so the client and the docs share one source of truth.
 */
const POLL_INTERVAL_MS = 18000;

/** The subset of the render context the reconcilable stream region needs. */
type StreamRegionCtx = Pick<
  RenderContext,
  'items' | 'filters' | 'basePath' | 'page' | 'pageCount' | 'showDownload' | 'video'
>;

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
${THEME_VARS_CSS}
${overrides}
*{box-sizing:border-box}
html{background:var(--bg);transition:background var(--tr),color var(--tr)}
/* Embedded (iframe) → the host scrolls the auto-sized frame; the frame body must NOT
   show its own scrollbar, or a transient one flashes between an append and the height
   re-post (CCB-S2-010). Direct (top-level) views keep the normal document scrollbar. */
html.embedded{overflow:hidden}
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
/* Hers, marked quietly (CCB-S3-007 §4): a reader should be able to tell whose
   voice a line is in without the archive turning into two visual systems. */
.item.from-bot{border-left:2px solid color-mix(in srgb,var(--accent) 55%,transparent)}
.item .badge-bot{color:var(--accent);font-size:.85em;line-height:1;opacity:.85}
/* The pairing is shown, not left to be inferred from timestamps (CCB-S3-009). */
.item .reply-to{font-size:.8em;opacity:.7;text-decoration:none;color:var(--accent)}
.item .reply-to:hover{opacity:1;text-decoration:underline}
.item .body{white-space:pre-wrap;margin:0}
.item img.media{max-width:100%;height:auto;border-radius:8px;margin-top:8px;display:block}
.item video.media{display:block;width:100%;max-height:560px;margin-top:8px;border-radius:8px;background:#000;border:1px solid var(--border);object-fit:contain}
.item .dl-btn{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--accent);font-size:.85rem;font-weight:600;text-decoration:none;transition:var(--tr)}
.item .dl-btn:hover{border-color:var(--accent);color:var(--accent-bright)}
.item .dl-btn svg{width:16px;height:16px;flex:none}
.item .filelink{display:inline-block;margin-top:8px;color:var(--accent);font-weight:600;text-decoration:none}
.item .video-card{margin-top:8px}
.item .video-play{position:relative;display:block;width:100%;padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#000;cursor:pointer;aspect-ratio:16/9}
.item .video-thumb{display:block;width:100%;height:100%;object-fit:cover}
.item .video-thumb-placeholder{display:block;width:100%;height:100%;background:linear-gradient(135deg,var(--bg-card),#000)}
.item .video-play-icon{position:absolute;top:50%;left:50%;width:64px;height:64px;transform:translate(-50%,-50%);border-radius:50%;background:rgba(0,0,0,.55);border:2px solid #fff;transition:var(--tr)}
.item .video-play-icon::after{content:"";position:absolute;top:50%;left:54%;transform:translate(-50%,-50%);border-style:solid;border-width:12px 0 12px 20px;border-color:transparent transparent transparent #fff}
.item .video-play:hover .video-play-icon,.item .video-play:focus-visible .video-play-icon{background:var(--accent);border-color:#fff}
.item .video-frame{display:block;width:100%;aspect-ratio:16/9;border:1px solid var(--border);border-radius:8px;background:#000}
.item .video-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-top:6px}
.item .video-title{font-weight:600}
.item .video-notice{color:var(--muted);font-size:.8rem}
.item .video-open{color:var(--accent);font-weight:600;text-decoration:none;font-size:.85rem;margin-left:auto}
.item .video-open:hover{color:var(--accent-bright)}
.item details.report{margin-top:8px}
.item details.report>summary{cursor:pointer;list-style:none;color:var(--muted);font-size:.85rem}
.item details.report>summary::-webkit-details-marker{display:none}
.item details.report[open]{padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card)}
.item details.report form{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.item details.report .rlabel{display:flex;flex-direction:column;gap:4px;font-size:.8rem;color:var(--muted)}
.item details.report select,.item details.report textarea{padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-dark);color:var(--fg);font:inherit;font-size:.85rem}
.item details.report button{align-self:flex-start;padding:6px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;font-size:.85rem}
.report-ok{margin:12px 0;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--fg)}
.item .links{margin:8px 0 0;padding:0;list-style:none}
.item .links a{color:var(--accent)}
.pager{display:flex;justify-content:space-between;align-items:center;margin:20px 0;color:var(--muted);font-size:.9rem}
.pager a{color:var(--accent);font-weight:600;text-decoration:none}
.empty{color:var(--muted);text-align:center;padding:40px 0}
#stream-top-sentinel,#stream-bottom-sentinel{height:1px;margin:0}
#stream-top-spacer{width:100%}
.stream-status{color:var(--muted);text-align:center;font-size:.85rem;padding:14px 0;margin:0}
.stream-status button{margin-top:6px;padding:8px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--accent);font-weight:600;cursor:pointer;font-size:.85rem;transition:var(--tr)}
.stream-status button:hover{border-color:var(--accent)}
/* Skeleton loader (CCB-S2-010) — reserves space with shimmer placeholder cards so a
   loading chunk never jumps the layout; an indeterminate shimmer (the chunk fetch is
   small/fast, so byte-progress would add no value). */
.skeleton-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin:0;list-style:none;position:relative;overflow:hidden}
.skeleton-card .sk-line{height:12px;border-radius:6px;background:var(--bg-dark)}
.skeleton-card .sk-line+.sk-line{margin-top:10px}
.skeleton-card .sk-line.short{width:45%}
.skeleton-card::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--text) 10%,transparent),transparent);animation:sk-shimmer 1.3s ease-in-out infinite}
@keyframes sk-shimmer{100%{transform:translateX(100%)}}
/* Appended cards fade+rise in so inserts feel smooth, not jerky (GPU opacity/transform). */
.item.card-in{animation:card-in .28s ease both}
@keyframes card-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.skeleton-card::after{animation:none}.item.card-in{animation:none}}
footer.arch{margin-top:24px;color:var(--muted);font-size:.8rem;text-align:center}
a{color:var(--accent)}
`.trim();
}

/** No-flash boot for the archive front — the shared theme boot plus the iframe-only
 * `html.embedded` marker (CCB-S2-010). Toggle markup/script + palette are shared with
 * the marketing site via src/web/theme.ts. */
function noFlashScript(auto: boolean): string {
  return themeBootScript(auto, true);
}

/** Download-glyph icon (inline SVG, currentColor). */
const DL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

const VIDEO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
};

/** A friendly download filename extension from the stored mime (best-effort). */
function mediaExt(it: PublicItem): string {
  return (it.mediaMime && VIDEO_EXT[it.mediaMime]) || (it.type === 'video' ? 'mp4' : 'bin');
}

/** The themed "Download" button (only rendered when the instance enables it). */
function downloadButton(it: PublicItem, mediaUrl: string): SafeHtml {
  return html`<a
    class="dl-btn"
    href="${mediaUrl}"
    download="cinderella-${it.type}-${it.id}.${mediaExt(it)}"
    rel="noopener"
    >${raw(DL_ICON)} Download</a
  >`;
}

/** Renders one published item's media/body into the card. */
function itemMedia(
  it: PublicItem,
  mediaUrl: string,
  showDownload: boolean,
  video: VideoCardOpts,
): SafeHtml {
  // A recognised, enabled video link renders as a click-to-play card
  // (CCB-S3-014). When embedding is off, or its provider is not enabled, it falls
  // through and renders as a plain link in itemLinks().
  if (
    it.video &&
    video.embed &&
    video.providers.includes(it.video.provider) &&
    it.type === 'link'
  ) {
    return videoCard(it, mediaUrl, video);
  }
  if (it.type === 'image' && it.hasMedia) {
    return html`<img
      class="media"
      src="${mediaUrl}"
      alt="Image from ${it.senderDisplayName}"
      loading="lazy"
    />`;
  }
  // Video plays INLINE (CCB-S2-008): native controls (play/seek/volume/fullscreen),
  // no autoplay, metadata-only preload so a stream of videos doesn't fetch everything.
  // When downloads are off, hide the button AND the native download control.
  if (it.type === 'video' && it.hasMedia) {
    const noDl = showDownload ? '' : ' controlslist="nodownload"';
    const player = html`<video
      class="media video"
      src="${mediaUrl}"
      controls
      preload="metadata"
      playsinline${raw(noDl)}
    ></video>`;
    return showDownload ? html`${player}${downloadButton(it, mediaUrl)}` : player;
  }
  if (it.hasMedia && (it.type === 'voice' || it.type === 'file')) {
    const label = it.type === 'voice' ? 'Play voice' : 'Download file';
    return html`<a class="filelink" href="${mediaUrl}" rel="noopener">${label} →</a>`;
  }
  return html``;
}

/**
 * A click-to-play video card (CCB-S3-014).
 *
 * NOTHING third-party loads until the visitor clicks. The thumbnail is our own
 * (`mediaUrl`, consent-gated and metadata-stripped) or a CSS placeholder; the
 * player iframe is written by the click handler in the client script, never on
 * load, scroll or hover. The notice names the service so the visitor knows what
 * a click will load, and the "open on …" link lets them leave instead.
 *
 * `data-embed` carries the nocookie player URL; the click handler reads it. It is
 * the only third-party URL on the page, and it is inert until clicked.
 */
function videoCard(it: PublicItem, mediaUrl: string, video: VideoCardOpts): SafeHtml {
  const v = it.video;
  if (!v) return html``;
  const canonical = canonicalVideoUrl(v);
  const title = v.title ?? `Video on ${v.provider}`;
  const thumb = it.hasMedia
    ? html`<img class="video-thumb" src="${mediaUrl}" alt="${title}" loading="lazy" />`
    : html`<span class="video-thumb video-thumb-placeholder" aria-hidden="true"></span>`;
  return html`<div class="video-card" data-embed="${embedUrlFor(v)}" data-title="${title}">
    <button class="video-play" type="button" aria-label="Play video: ${title}">
      ${thumb}<span class="video-play-icon" aria-hidden="true"></span>
    </button>
    <div class="video-meta">
      <span class="video-title">${title}</span>
      ${
        video.showNotice
          ? html`<span class="video-notice"
              >▶ Playing loads content from ${v.provider === 'youtube' ? 'YouTube' : v.provider}.</span
            >`
          : null
      }
      <a class="video-open" href="${canonical}" rel="nofollow noopener" target="_blank"
        >Open on ${v.provider === 'youtube' ? 'YouTube' : v.provider} →</a
      >
    </div>
  </div>`;
}

/** The nocookie player URL for a stored video (mirrors media/video.ts). */
function embedUrlFor(v: NonNullable<PublicItem['video']>): string {
  const start = v.startSeconds > 0 ? `?start=${v.startSeconds}` : '';
  return `https://www.youtube-nocookie.com/embed/${v.videoId}${start}`;
}

/** The public page URL — the "open on YouTube" link and JSON-LD contentUrl. */
function canonicalVideoUrl(v: NonNullable<PublicItem['video']>): string {
  const t = v.startSeconds > 0 ? `&t=${v.startSeconds}` : '';
  return `https://www.youtube.com/watch?v=${v.videoId}${t}`;
}

function itemLinks(it: PublicItem, video: VideoCardOpts): SafeHtml {
  // If this link rendered as a video card, do not repeat it as a plain link.
  const asVideo =
    it.video && video.embed && video.providers.includes(it.video.provider) && it.type === 'link';
  if (asVideo || it.links.length === 0) return html``;
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
 * The card sequence (`<li>` items only, no `<ul>` wrapper). Shared by the SSR
 * region and the `/embed/:id/page` cursor endpoint (CCB-S2-007), so appended
 * infinite-scroll cards are byte-identical to SSR. Each card carries `data-cursor`
 * (its exact `(sent_at,id)` sort key) so the client can page/window/reconcile from
 * the DOM alone. Consent-gated items only — inserted via `insertAdjacentHTML`, which
 * runs no scripts, and media stays under the page's `img-src`/`media-src 'self'`.
 */
export function renderCards(
  items: PublicItem[],
  basePath: string,
  showDownload: boolean,
  video: VideoCardOpts,
): SafeHtml {
  return html`${items.map(
    (it) =>
      html`<li class="item${it.isBot ? ' from-bot' : ''}" id="msg-${it.id}" data-cursor="${it.cursor}">
        <div class="meta">
          <span class="who">${it.senderDisplayName}</span>
          ${it.isBot ? html`<span class="badge-bot" title="Written by Cinderella">✦</span>` : html``}
          ${
            it.replyToId !== null
              ? html`<a class="reply-to" href="#msg-${it.replyToId}" title="In reply to"
                  >↩ in reply</a
                >`
              : html``
          }
          <time datetime="${it.sentAt}">${fmtTime(it.sentAt)}</time>
        </div>
        ${it.textBody ? html`<p class="body">${it.textBody}</p>` : html``}
        ${itemMedia(it, `${basePath}/media/${it.id}`, showDownload, video)} ${itemLinks(it, video)}
        ${reportControl(it, basePath)}
      </li>`,
  )}`;
}

const REASON_OPTIONS: [string, string][] = [
  ['illegal', 'Illegal content'],
  ['spam', 'Spam'],
  ['copyright', 'Copyright infringement'],
  ['other', 'Other'],
];

/**
 * Per-item "Report" control (CCB-S2-009) — a no-JS `<details>` disclosure wrapping a
 * plain POST form (works under the strict front CSP; no inline handlers). Reporting
 * never changes publication (visible-until-review); the endpoint is consent-gated +
 * rate-limited server-side. Lives in each card, so it survives infinite-scroll appends
 * and the live reconcile (which removes/adds whole cards, never rewriting one in place).
 */
function reportControl(it: PublicItem, basePath: string): SafeHtml {
  return html`<details class="report">
    <summary>Report</summary>
    <form method="post" action="${basePath}/report">
      <input type="hidden" name="msg" value="${it.id}" />
      <label class="rlabel"
        >Reason
        <select name="reason">
          ${REASON_OPTIONS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}
        </select></label
      >
      <label class="rlabel"
        >Note (optional) <textarea name="note" maxlength="1000" rows="2"></textarea>
      </label>
      <button type="submit">Submit report</button>
    </form>
  </details>`;
}

/**
 * The stream region: the item list (or empty state) plus the no-JS pager. Rendered
 * inside `#stream-list` on the SSR page. The pager remains for crawlers + JS-off
 * visitors; the infinite-scroll client hides it once it initializes (CCB-S2-007).
 */
function renderStreamRegion(ctx: StreamRegionCtx): SafeHtml {
  const items =
    ctx.items.length > 0
      ? html`<ul class="items">
          ${renderCards(ctx.items, ctx.basePath, ctx.showDownload, ctx.video)}
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
        ${seo.prevUrl ? html`<link rel="prev" href="${seo.prevUrl}" />` : null}
        ${seo.nextUrl ? html`<link rel="next" href="${seo.nextUrl}" />` : null}
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
          ${
            ctx.reported
              ? html`<p class="report-ok">
                  Thank you — your report was received and will be reviewed.
                </p>`
              : null
          }
          <div
            id="stream-list"
            data-hash="${ctx.streamHash ?? ''}"
            data-poll="${POLL_INTERVAL_MS}"
            data-next-cursor="${ctx.nextCursor}"
            data-has-more="${ctx.hasMore ? '1' : '0'}"
            data-at-top="${ctx.page === 1 ? '1' : '0'}"
            data-page-size="${ctx.cursorPageSize}"
            data-window-cap="${ctx.windowCap}"
          >
            <div id="stream-top-spacer" style="height: 0"></div>
            <div id="stream-top-sentinel" aria-hidden="true"></div>
            ${region}
            <div id="stream-bottom-sentinel" aria-hidden="true"></div>
            <p class="stream-status" role="status" hidden></p>
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
          ${raw(STREAM_SCRIPT)};
        </script>
        <script nonce="${ctx.nonce}">
          ${raw(VIDEO_SCRIPT)};
        </script>
      </body>
    </html>`;

  return body.toString();
}

/** Posts the document height to the embedding parent (Season 1 snippet contract).
 * Also fires when a video's layout settles (loadedmetadata) and on fullscreen
 * enter/exit (CCB-S2-008), so the host iframe resizes cleanly around inline video.
 * Safety net (CCB-S2-010): when framed, `html.embedded` hides the body scrollbar
 * (the host scrolls the auto-sized frame); if a host isn't auto-sizing us (content
 * still overflows the frame viewport ~1.5s after load), restore `overflow-y:auto` so
 * content is never clipped/unreachable in a misconfigured embed. */
/**
 * Click-to-play (CCB-S3-014). Delegated on the document, so it covers both SSR
 * cards and ones appended by infinite scroll. NOTHING loads until a click: only
 * then is the nocookie iframe written, with autoplay (user-initiated) and
 * fullscreen. It is the only place a third-party URL becomes live.
 */
const VIDEO_SCRIPT = `(function(){document.addEventListener('click',function(e){var t=e.target;if(!t||!t.closest)return;var btn=t.closest('.video-play');if(!btn)return;var card=btn.closest('.video-card');if(!card)return;var src=card.getAttribute('data-embed');if(!src)return;e.preventDefault();var sep=src.indexOf('?')<0?'?':'&';var f=document.createElement('iframe');f.className='video-frame';f.src=src+sep+'autoplay=1';f.title=card.getAttribute('data-title')||'Video';f.setAttribute('allow','autoplay; fullscreen; encrypted-media; picture-in-picture');f.setAttribute('allowfullscreen','');f.setAttribute('referrerpolicy','no-referrer');btn.parentNode.replaceChild(f,btn);try{f.focus();}catch(_){}});})();`;

const HEIGHT_SCRIPT = `(function(){function h(){try{parent.postMessage({cinderellaEmbedHeight:document.documentElement.scrollHeight},'*')}catch(e){}}addEventListener('load',h);addEventListener('resize',h);document.addEventListener('loadedmetadata',h,true);document.addEventListener('fullscreenchange',h);if(window.ResizeObserver){new ResizeObserver(h).observe(document.documentElement)}h();if(document.documentElement.classList.contains('embedded')){setTimeout(function(){if(document.documentElement.scrollHeight>window.innerHeight+4)document.documentElement.style.overflowY='auto';},1500);}})();`;

/**
 * Stream client (CCB-S2-007) — infinite scroll + DOM windowing + live reconcile
 * over ONE loaded-item model, progressive enhancement (SSR + no-JS pager stay
 * intact). Replaces the CCB-S2-006 wholesale-fragment swap, which was incompatible
 * with appended pages. Three drivers, serialized by a single-flight `busy` flag:
 *  - bottom sentinel → `GET /page?dir=older` appends older cards, then windows the
 *    top (removing far-above cards behind a height-preserving spacer);
 *  - top sentinel → `GET /page?dir=newer` restores windowed-off cards on scroll-up
 *    (RE-FETCH, never a stash — so a card recalled while off-screen can't return);
 *  - ~18s poll → `GET /state?cursor=<bottom>&top=<top>` over the EXACT loaded band:
 *    sweeps out any recalled id wherever it sits, and (only when at the true top)
 *    prepends new publishes. All same-origin (CSP `connect-src 'self'`), consent-
 *    gated server-side; the client never sees an unpublished id. Re-posts iframe
 *    height after every mutation; pauses while hidden. In an auto-height iframe the
 *    bottom sentinel is always in view, so auto-loads are burst-capped, then a
 *    "Load older" button takes over (the SSR pager is the ultimate fallback).
 */
const STREAM_SCRIPT = `(function(){
  var root=document.getElementById('stream-list');
  if(!root||!window.fetch)return;
  var base=location.pathname.replace(/\\/+$/,'');
  var qs=location.search;
  var POLL=Math.max(8000,parseInt(root.getAttribute('data-poll'),10)||18000);
  function get(u){return fetch(u,{credentials:'omit',headers:{accept:'application/json'}});}
  function postHeight(){try{parent.postMessage({cinderellaEmbedHeight:document.documentElement.scrollHeight},'*');}catch(e){}}
  var ul=root.querySelector('ul.items');
  if(!ul||!window.IntersectionObserver){
    // Empty view (or no IO support): still reflect an empty->content transition.
    var eh=root.getAttribute('data-hash')||'',et=null;
    function eTick(){if(document.hidden)return;get(base+'/state'+qs).then(function(r){return r.ok?r.json():null;}).then(function(s){if(s&&typeof s.hash==='string'&&s.hash!==eh)location.reload();}).catch(function(){});}
    document.addEventListener('visibilitychange',function(){if(!document.hidden)eTick();});
    if(!document.hidden)et=setInterval(eTick,POLL);
    return;
  }
  var spacer=document.getElementById('stream-top-spacer');
  var topSent=document.getElementById('stream-top-sentinel');
  var botSent=document.getElementById('stream-bottom-sentinel');
  var statusEl=root.querySelector('.stream-status');
  var pager=root.querySelector('nav.pager');
  var CAP=Math.max(60,parseInt(root.getAttribute('data-window-cap'),10)||200);
  var KEEP=Math.max(30,Math.floor(CAP*0.75));
  var MIN_INTERVAL=250,MAX_BURST=5;
  var atStreamTop=root.getAttribute('data-at-top')==='1';
  var nextCursor=root.getAttribute('data-next-cursor')||'';
  var hasMoreOlder=root.getAttribute('data-has-more')==='1';
  var lastHash=root.getAttribute('data-hash')||'';
  var loaded=[],idset={};
  Array.prototype.forEach.call(ul.querySelectorAll('li.item[data-cursor]'),function(li){
    var id=li.id.replace('msg-','');loaded.push({id:id,cursor:li.getAttribute('data-cursor'),el:li});idset[id]=1;
  });
  var hasWindowedNewer=false,busy=false,lastLoad=0,autoBurst=0,manual=false,timer=null,backoff=800,skeletons=[];
  // At the true stream head only when the SSR entry was page 1 AND nothing is
  // windowed above (a deep ?page=N entry must NOT auto-prepend newer cards).
  function atTop(){return atStreamTop&&!hasWindowedNewer;}
  function fwd(path,extra){return base+path+(qs?qs+'&':'?')+extra;}
  function setStatus(msg,btn,onClick){
    if(!statusEl)return;
    statusEl.textContent=msg||'';
    if(btn){var b=document.createElement('button');b.type='button';b.textContent=btn;b.addEventListener('click',onClick);statusEl.appendChild(b);}
    statusEl.hidden=!(msg||btn);
  }
  function parseCards(h){var t=document.createElement('template');t.innerHTML=h||'';return t.content.querySelectorAll('li.item[data-cursor]');}
  var SK_LI='<li class="skeleton-card" aria-hidden="true"><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line short"></div></li>';
  // Reserve space at the bottom with shimmer cards while a chunk fetches, so the real
  // cards drop into place with no layout jump + a clear loading state (CCB-S2-010).
  function showSkeleton(){if(skeletons.length)return;for(var i=0;i<3;i++){var t=document.createElement('template');t.innerHTML=SK_LI;var el=t.content.firstElementChild;ul.appendChild(el);skeletons.push(el);}postHeight();}
  function removeSkeleton(){for(var i=0;i<skeletons.length;i++){var el=skeletons[i];if(el.parentNode)el.parentNode.removeChild(el);}skeletons=[];}
  function onError(retry){removeSkeleton();setStatus('Couldn\\u2019t load.',retry?'Retry':null,retry||null);if(retry){setTimeout(function(){if(!busy)retry();},backoff);backoff=Math.min(backoff*2,15000);}}
  function loadOlder(auto){
    if(busy||!hasMoreOlder||!nextCursor)return;
    if(Date.now()-lastLoad<MIN_INTERVAL)return;
    busy=true;lastLoad=Date.now();if(!manual)showSkeleton();
    get(fwd('/page','dir=older&cursor='+encodeURIComponent(nextCursor))).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(d){
      busy=false;backoff=800;removeSkeleton();setStatus('');
      Array.prototype.forEach.call(parseCards(d.html),function(li){var id=li.id.replace('msg-','');if(idset[id])return;li.className+=' card-in';ul.appendChild(li);loaded.push({id:id,cursor:li.getAttribute('data-cursor'),el:li});idset[id]=1;});
      nextCursor=d.nextCursor||'';hasMoreOlder=!!d.hasMore;
      if(!hasMoreOlder)io.unobserve(botSent);
      trimTop();postHeight();
      if(auto){autoBurst++;if(autoBurst>=MAX_BURST)enterManual();}else{autoBurst=0;}
    }).catch(function(){busy=false;onError(function(){loadOlder(false);});});
  }
  function watchMedia(li){
    // Lazy <img>/<video> grow AFTER insert; shrink the spacer by each settle delta
    // so restored content doesn't drift the reader (#S2-007 review).
    Array.prototype.forEach.call(li.querySelectorAll('img,video'),function(el){
      var h0=el.offsetHeight;
      function adj(){var d=el.offsetHeight-h0;if(d>0){spacer.style.height=Math.max(0,(parseInt(spacer.style.height,10)||0)-d)+'px';h0=el.offsetHeight;postHeight();}}
      el.addEventListener('load',adj);el.addEventListener('loadedmetadata',adj);
    });
  }
  function doPrepend(fromCursor,restore){
    if(busy||!fromCursor)return;
    if(Date.now()-lastLoad<MIN_INTERVAL)return;
    busy=true;lastLoad=Date.now();
    get(fwd('/page','dir=newer&cursor='+encodeURIComponent(fromCursor))).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(d){
      busy=false;backoff=800;setStatus('');
      var frag=document.createDocumentFragment(),fresh=[],k;
      Array.prototype.forEach.call(parseCards(d.html),function(li){var id=li.id.replace('msg-','');if(idset[id])return;li.className+=' card-in';frag.appendChild(li);fresh.push({id:id,cursor:li.getAttribute('data-cursor'),el:li});idset[id]=1;});
      if(fresh.length){ul.insertBefore(frag,ul.firstChild);loaded=fresh.concat(loaded);
        if(restore){var h=0;for(k=0;k<fresh.length;k++)h+=fresh[k].el.offsetHeight;spacer.style.height=Math.max(0,(parseInt(spacer.style.height,10)||0)-h)+'px';for(k=0;k<fresh.length;k++)watchMedia(fresh[k].el);}
      }
      if(restore&&(!d.hasMore||(parseInt(spacer.style.height,10)||0)<=0)){spacer.style.height='0';hasWindowedNewer=false;}
      trimBottom();postHeight();
    }).catch(function(){busy=false;onError(null);});
  }
  function trimTop(){
    if(loaded.length<=CAP)return;
    var remove=loaded.length-KEEP,h=0;
    for(var i=0;i<remove;i++){var it=loaded[i];h+=it.el.offsetHeight;if(it.el.parentNode)it.el.parentNode.removeChild(it.el);delete idset[it.id];}
    loaded=loaded.slice(remove);
    spacer.style.height=((parseInt(spacer.style.height,10)||0)+h)+'px';
    hasWindowedNewer=true;postHeight();
  }
  function trimBottom(){
    // Symmetric to trimTop: keep loaded <= CAP on the UPWARD path so it never
    // exceeds the /state span LIMIT (which would truncate and wrongly evict still-
    // published cards). Reset nextCursor to the new oldest kept card so scroll-down
    // re-fetches the trimmed tail contiguously — no dupe, no gap (#S2-007 review).
    if(loaded.length<=CAP)return;
    var remove=loaded.length-KEEP,i;
    for(i=0;i<remove;i++){var it=loaded[loaded.length-1-i];if(it.el.parentNode)it.el.parentNode.removeChild(it.el);delete idset[it.id];}
    loaded=loaded.slice(0,KEEP);
    nextCursor=loaded[loaded.length-1].cursor;hasMoreOlder=true;io.observe(botSent);
    postHeight();
  }
  function reconcile(s){
    var live={};for(var i=0;i<s.ids.length;i++)live[String(s.ids[i])]=1;
    var changed=false;
    for(var j=loaded.length-1;j>=0;j--){var it=loaded[j];if(!live[it.id]){if(it.el.parentNode)it.el.parentNode.removeChild(it.el);loaded.splice(j,1);delete idset[it.id];changed=true;}}
    if(changed)postHeight();
    if(atTop()&&s.hasNewer&&loaded.length)doPrepend(loaded[0].cursor,false);
  }
  function tick(){
    if(busy||document.hidden||!loaded.length)return;
    var top=loaded[0].cursor,bottom=loaded[loaded.length-1].cursor;
    // Hold the single-flight lock across the poll so no load mutates loaded[] while
    // the span is in flight (else reconcile would sweep cards outside the stale band).
    busy=true;
    get(fwd('/state','cursor='+encodeURIComponent(bottom)+'&top='+encodeURIComponent(top))).then(function(r){return r.ok?r.json():null;}).then(function(s){
      busy=false;
      if(!s||typeof s.hash!=='string')return;
      // The band hash misses a publish NEWER than top — so also proceed on hasNewer.
      if(s.hash===lastHash&&!s.hasNewer)return;
      lastHash=s.hash;reconcile(s);
    }).catch(function(){busy=false;});
  }
  var io=new IntersectionObserver(function(entries){
    for(var i=0;i<entries.length;i++){var e=entries[i];if(!e.isIntersecting)continue;
      if(e.target===botSent){if(!manual)loadOlder(true);}
      else if(e.target===topSent){if(hasWindowedNewer&&loaded.length)doPrepend(loaded[0].cursor,true);}
    }
  },{rootMargin:'600px 0px'});
  function enterManual(){manual=true;io.unobserve(botSent);setStatus('',hasMoreOlder?'Load older messages':null,exitManual);}
  function exitManual(){if(!manual)return;manual=false;autoBurst=0;setStatus('');if(hasMoreOlder)io.observe(botSent);}
  addEventListener('scroll',function(){autoBurst=0;if(manual)exitManual();},{passive:true});
  if(hasMoreOlder)io.observe(botSent);
  io.observe(topSent);
  function start(){if(!timer)timer=setInterval(tick,POLL);}
  function stop(){if(timer){clearInterval(timer);timer=null;}}
  document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else{start();tick();}});
  if(!document.hidden)start();
  // Hide the no-JS pager only at the true head (page 1); a deep ?page=N entry keeps
  // it so a JS visitor can still navigate to newer pages (infinite scroll only pages older).
  if(pager&&atStreamTop)pager.style.display='none';
})();`;

/** Compact UTC timestamp for display (deterministic, locale-independent). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
