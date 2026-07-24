/**
 * Marketing-site icons (CCB-S3-001) — lucide SVGs inlined server-side so the site
 * stays fully self-contained under its strict CSP (no CDN, no external fetch).
 * The template used lucide-static via CDN CSS masks; here the same icons render as
 * inline `<svg>` with `currentColor`, visually identical and indexable-safe.
 *
 * Icons are read once from the vendored `lucide-static` package (a production
 * dependency) and cached. `github` was removed from newer lucide-static releases,
 * so its path data is carried inline.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { raw, type SafeHtml } from '../html.js';
import { log } from '../../log.js';

const ICONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'node_modules',
  'lucide-static',
  'icons',
);

/** Inner markup fallbacks for icons missing from the vendored lucide-static. */
const EXTRA_ICONS: Record<string, string> = {
  github:
    '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
};

const cache = new Map<string, string>();

/** The inner SVG markup (paths only) for a lucide icon name; '' when unknown. */
function iconInner(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let inner = EXTRA_ICONS[name] ?? '';
  if (!inner) {
    try {
      const file = readFileSync(join(ICONS_DIR, `${name}.svg`), 'utf8');
      const m = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(file);
      inner = (m?.[1] ?? '').trim();
    } catch (err) {
      // Every caller passes a fixed authoring-time icon name, so a read failure is a
      // defect (a lucide-static bump renamed/removed the file), not an unknown name.
      // Log it, or a known icon silently renders blank forever (CCB-S3-023).
      inner = '';
      log.warn(
        `Site icon "${name}" could not be read from lucide-static (${err instanceof Error ? err.message : String(err)}); rendering blank.`,
      );
    }
  }
  cache.set(name, inner);
  return inner;
}

/** Icon color as a CLASS (`.ic-<tone>` in css.ts) — never a style attribute: the
 * site CSP (`style-src 'nonce-…'`) blocks inline style attributes. */
export type IconTone = 'accent' | 'muted' | 'faint' | 'neon' | 'success';

export interface SiteIconOpts {
  size?: number;
  /** Color tone class; defaults to currentColor (inherit). */
  tone?: IconTone;
  className?: string;
  /** Accessible label; icons are aria-hidden without one. */
  label?: string;
}

/** An inline lucide icon (stroke: currentColor), CSP-safe. */
export function siteIcon(name: string, opts: SiteIconOpts = {}): SafeHtml {
  const size = opts.size ?? 20;
  const inner = iconInner(name);
  const classes = [opts.className, opts.tone ? `ic-${opts.tone}` : ''].filter(Boolean).join(' ');
  const cls = classes ? ` class="${classes}"` : '';
  const a11y = opts.label ? ` role="img" aria-label="${opts.label}"` : ' aria-hidden="true"';
  return raw(
    `<svg${cls}${a11y} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`,
  );
}

/** A data: URI CSS mask for an icon (used by the pricing-tier check marks). */
export function iconMaskDataUri(name: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconInner(name)}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
