/**
 * Website settings model (CCB-S2-012) — the three admin-configurable "building
 * blocks" for the public marketing site, ALL disabled by default. Persisted in the
 * `settings` table under the `site` key (no migration — the table is a generic
 * key→JSONB store), edited in the admin console, audited on every change.
 *
 * Doctrine (D-025): analytics, the cookie banner and social share ship but default
 * OFF; the operator opts in and carries the legal responsibility (requirements
 * differ by country). Analytics is consent-gated — it can only load once the cookie
 * banner has gathered consent (see {@link shouldLoadAnalytics}). Share is script-free
 * links, so it needs no banner. Values are normalized from untrusted input.
 */

import { getSetting, setSetting } from '../db/settings.js';
import type { Queryable } from '../db/pool.js';
import { writeAudit } from '../db/audit.js';

/** Share targets that are pure link builders — no third-party script, no tracking.
 * Kept in step with {@link SHARE_NETWORKS} in src/web/share.ts (the URL/label/icon
 * source of truth); this is the settings-layer validation vocabulary. */
export const KNOWN_NETWORKS = [
  'x',
  'facebook',
  'reddit',
  'whatsapp',
  'telegram',
  'linkedin',
  'email',
] as const;
export type ShareNetwork = (typeof KNOWN_NETWORKS)[number];

export interface SiteSettings {
  analytics: {
    /** Master switch. Off by default; never loads before consent (see the banner). */
    enabled: boolean;
    /** Free-text provider label for the admin (e.g. "Plausible") — informational. */
    provider: string;
    /** HTTPS URL of the (first-party preferred) analytics snippet; '' = none. */
    scriptUrl: string;
  };
  cookieBanner: {
    /** Consent banner on/off. Gates analytics + any non-essential storage. */
    enabled: boolean;
    /** Link to the privacy policy shown in the banner; '' → the site's /legal page. */
    policyUrl: string;
  };
  socialShare: {
    /** Show script-free share links. Off by default; needs no banner. */
    enabled: boolean;
    /** Which networks to offer (subset of {@link KNOWN_NETWORKS}). */
    networks: ShareNetwork[];
  };
}

export const DEFAULT_SITE: SiteSettings = {
  analytics: { enabled: false, provider: '', scriptUrl: '' },
  cookieBanner: { enabled: false, policyUrl: '' },
  socialShare: { enabled: false, networks: [...KNOWN_NETWORKS] },
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function bool(v: unknown, d: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  return d;
}
function str(v: unknown, d: string, maxLen = 500): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : d;
}
/** An https:// URL, or '' when absent/invalid — never allow http/js: schemes. */
function httpsUrl(v: unknown): string {
  const s = str(v, '').trim();
  if (!s) return '';
  try {
    return new URL(s).protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
}
function networks(v: unknown): ShareNetwork[] {
  const arr = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(/[\s,]+/)
      : typeof v === 'object' && v
        ? Object.keys(v) // checkbox map { x:'on', ... }
        : [];
  const out: ShareNetwork[] = [];
  for (const item of arr) {
    const s = String(item).trim().toLowerCase();
    if ((KNOWN_NETWORKS as readonly string[]).includes(s) && !out.includes(s as ShareNetwork)) {
      out.push(s as ShareNetwork);
    }
  }
  return out;
}

export function normalizeSite(input: unknown): SiteSettings {
  const d = DEFAULT_SITE;
  const o = rec(input);
  const a = rec(o['analytics']);
  const c = rec(o['cookieBanner']);
  const sh = rec(o['socialShare']);
  return {
    analytics: {
      enabled: bool(a['enabled'], d.analytics.enabled),
      provider: str(a['provider'], d.analytics.provider, 60).trim(),
      scriptUrl: httpsUrl(a['scriptUrl']),
    },
    cookieBanner: {
      enabled: bool(c['enabled'], d.cookieBanner.enabled),
      policyUrl: httpsUrl(c['policyUrl']),
    },
    socialShare: {
      enabled: bool(sh['enabled'], d.socialShare.enabled),
      networks: 'networks' in sh ? networks(sh['networks']) : [...d.socialShare.networks],
    },
  };
}

/**
 * The consent invariant, in one place: analytics may load ONLY when it is enabled,
 * has a script URL, AND the cookie banner is enabled to gather consent. With the
 * banner off there is no consent mechanism, so no tracking — even if analytics is
 * toggled on. The renderer defers the actual load until the visitor accepts.
 */
export function shouldLoadAnalytics(s: SiteSettings): boolean {
  return s.analytics.enabled && s.analytics.scriptUrl !== '' && s.cookieBanner.enabled;
}

const SITE_KEY = 'site';

/** In-process cache of the website settings, refreshed on write. */
export class SiteService {
  private constructor(
    private readonly db: Queryable,
    private current: SiteSettings,
  ) {}

  static async load(db: Queryable): Promise<SiteService> {
    const stored = await getSetting(db, SITE_KEY);
    return new SiteService(db, normalizeSite(stored ?? {}));
  }

  /** Synchronous all-defaults service — used by buildServer as a fallback and by
   * harnesses that don't seed a `site` row (everything OFF, matching production's
   * first boot). */
  static withDefaults(db: Queryable): SiteService {
    return new SiteService(db, normalizeSite({}));
  }

  get(): SiteSettings {
    return this.current;
  }

  async save(next: SiteSettings, actor: string): Promise<void> {
    const normalized = normalizeSite(next);
    await setSetting(this.db, SITE_KEY, normalized);
    await writeAudit(this.db, actor, 'site.update', 'site', normalized);
    this.current = normalized;
  }
}
