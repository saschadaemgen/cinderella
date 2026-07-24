/**
 * Shared SimpleGo house theme (CCB-S2-005) — the SINGLE source of truth for the
 * dark-default light/dark palette, the sun/moon toggle markup, and the no-flash boot
 * script. Consumed by BOTH the public archive front (src/web/front) and the public
 * marketing site (src/web/site, CCB-S2-012) so the two surfaces stay visually
 * identical and a palette change lands in exactly one place.
 *
 * Theme state lives in localStorage under `sg-theme` ('light' | 'dark'); dark is the
 * default (`[data-theme="dark"]`), light is bare `:root`. Component CSS consumes the
 * `--bg / --fg / --muted / --card / --accent / --border` aliases, which re-resolve
 * per theme. Each surface owns its own LAYOUT css; this module owns the palette
 * variables + the theme behaviour only.
 */

/** The theme-color meta values, kept in sync with the palette backgrounds. */
export const THEME_COLORS = { light: '#FAFBFD', dark: '#050A12' } as const;

/**
 * The palette custom properties: light (`:root`) + dark (`[data-theme="dark"]`). The
 * exact block the archive front has always emitted — extracted verbatim so the front
 * output stays byte-identical while the marketing site reuses the same tokens.
 */
export const THEME_VARS_CSS = `:root{
  --font:'Source Sans 3','Source Sans Pro',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  --radius:12px;--radius-sm:8px;--radius-lg:16px;--tr:0.3s cubic-bezier(0.4,0,0.2,1);
  --accent:#1A7D5A;--accent-bright:#146B4C;
  --bg-deep:#FAFBFC;--bg-dark:#F0F3F5;--bg-card:rgba(255,255,255,0.92);
  --text:#2C3440;--text-bright:#111827;--text-dim:rgba(44,52,64,0.55);
  --border:rgba(26,125,90,0.12);color-scheme:light;
  /* Low-emphasis destructive red (CCB-S3-025), from the house design system
     (site --red-400/--red-600): muted at rest, full strength on hover. */
  --danger:#E5646E;--danger-strong:#C2434E;
  --bg:var(--bg-deep);--fg:var(--text);--muted:var(--text-dim);--card:var(--bg-card);
}
[data-theme="dark"]{
  --accent:#45BDD1;--accent-bright:#6DD0DF;
  --bg-deep:#050A12;--bg-dark:#080D18;--bg-card:rgba(10,18,32,0.7);
  --text:#CBD5E1;--text-bright:#E8EDF4;--text-dim:rgba(203,213,225,0.5);
  --border:rgba(69,189,209,0.12);color-scheme:dark;
  --danger:#E5646E;--danger-strong:#C2434E;
}`;

/** Sun/moon toggle button (inline SVGs, currentColor). CSS lives in each surface. */
export const THEME_TOGGLE = `<button type="button" id="sg-theme-toggle" class="theme-toggle" aria-label="Toggle theme"><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>`;

/** Click handler: flip `data-theme`, persist to `sg-theme`, re-sync `theme-color`. */
export const THEME_TOGGLE_SCRIPT = `(function(){var b=document.getElementById('sg-theme-toggle');if(!b)return;function c(t){var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',t==='light'?'${THEME_COLORS.light}':'${THEME_COLORS.dark}');}b.addEventListener('click',function(){var cur=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';var n=cur==='light'?'dark':'light';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('sg-theme',n);}catch(e){}c(n);});})();`;

/**
 * No-flash `<head>` boot script — runs before body paint. Applies the stored theme
 * (`sg-theme`, shared across both surfaces) and syncs `theme-color`. When `auto`, an
 * absent choice falls back to `prefers-color-scheme`. `markEmbedded` adds the archive
 * front's iframe-only `html.embedded` marker (CCB-S2-010); the marketing site passes
 * false. With `markEmbedded=true` this is byte-identical to the front's original.
 */
export function themeBootScript(auto: boolean, markEmbedded: boolean): string {
  const embed = markEmbedded
    ? `try{if(window.self!==window.top)document.documentElement.classList.add('embedded');}catch(e){}`
    : '';
  return `(function(){${embed}try{var t=localStorage.getItem('sg-theme');if(!t&&${auto ? 'true' : 'false'})t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',t==='light'?'${THEME_COLORS.light}':'${THEME_COLORS.dark}');}}catch(e){}})();`;
}
