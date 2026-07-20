/**
 * `embed_instances` — the widget-config data model (A4). Each instance maps an
 * instance-id to the design/theme/filter settings the future public
 * `/embed/<instance-id>` route will resolve server-side. The widget rendering
 * itself is a later season; Season 0 owns the model, admin UI, and snippet
 * generator.
 */

import { randomBytes } from 'node:crypto';
import type { Queryable } from './pool.js';

/** Widget design/behaviour settings — all centralized, nothing on the host page. */
export interface EmbedSettings {
  theme: {
    mode: 'light' | 'dark' | 'auto';
    /** Hex colors, e.g. "#0f172a". */
    colorAccent: string;
    colorBackground: string;
    colorText: string;
  };
  layout: 'list' | 'grid';
  filters: {
    byType: boolean;
    byTime: boolean;
    search: boolean;
  };
  /** Which media types the widget shows. */
  media: {
    text: boolean;
    image: boolean;
    video: boolean;
    voice: boolean;
    file: boolean;
    link: boolean;
  };
  /** Full SEO & marketing suite (CCB-S2-004) — all admin-configurable. */
  seo: SeoSettings;
}

/**
 * Per-instance SEO / marketing configuration (CCB-S2-004). Every field is
 * admin-editable with a sensible default (D-015). Nothing here relaxes the
 * consent gate: the artifacts that consume it (structured data, sitemap, feed,
 * previews) still emit only published content (D-016).
 */
export interface SeoSettings {
  /** Title template; tokens `{instance}`, `{section}` (search/type context). */
  titleTemplate: string;
  /** Meta description (empty → a sensible generated default). */
  description: string;
  /** Comma-separated keywords (empty → omitted). */
  keywords: string;
  /** Robots meta directive for the public front, e.g. `index, follow`. */
  robots: string;
  /** Canonical base URL override (empty → the deployment origin). */
  canonicalBase: string;
  og: {
    siteName: string;
    locale: string;
    type: string;
    /** Operator-set absolute image URL (empty → auto/none). */
    imageUrl: string;
    /** Serve an auto-generated OG preview image per instance. */
    autoImage: boolean;
    /** Twitter @handle for `twitter:site` (empty → omitted). */
    twitterSite: string;
  };
  org: {
    name: string;
    url: string;
    logoUrl: string;
    /** Newline-separated profile URLs for schema.org `sameAs`. */
    sameAs: string;
  };
  /** schema.org type toggles for the JSON-LD `@graph`. */
  jsonld: {
    website: boolean;
    organization: boolean;
    itemList: boolean;
    postings: boolean;
    postingType: 'DiscussionForumPosting' | 'Article' | 'SocialMediaPosting';
    media: boolean;
  };
  feed: { enabled: boolean };
  /** Privacy-respecting analytics — external script URL (empty → OFF). Setting it
   * relaxes ONLY this instance's page CSP (the operator is told). */
  analytics: { scriptUrl: string };
}

export const DEFAULT_EMBED_SETTINGS: EmbedSettings = {
  theme: {
    mode: 'auto',
    colorAccent: '#0f766e',
    colorBackground: '#ffffff',
    colorText: '#0f172a',
  },
  layout: 'list',
  filters: { byType: true, byTime: true, search: true },
  media: { text: true, image: true, video: true, voice: true, file: true, link: true },
  seo: {
    titleTemplate: '{instance}{section}',
    description: '',
    keywords: '',
    robots: 'index, follow',
    canonicalBase: '',
    og: {
      siteName: 'Cinderella Archive',
      locale: 'en_US',
      type: 'website',
      imageUrl: '',
      autoImage: false,
      twitterSite: '',
    },
    org: { name: 'Cinderella', url: '', logoUrl: '', sameAs: '' },
    jsonld: {
      website: true,
      organization: true,
      itemList: true,
      postings: true,
      postingType: 'DiscussionForumPosting',
      media: true,
    },
    feed: { enabled: true },
    analytics: { scriptUrl: '' },
  },
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v) ? v.toLowerCase() : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  return fallback;
}

function str(v: unknown, fallback: string, max = 300): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

/** Validates an https URL (returns fallback for anything else) — used for every
 * operator-supplied URL so a stored/posted value can never inject javascript: etc. */
function httpsUrl(v: unknown, fallback: string): string {
  if (typeof v !== 'string' || v.trim() === '') return fallback;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

function normalizeRobots(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const t = v.trim().slice(0, 80);
  return t.length > 0 && /^[a-z, :-]+$/i.test(t) ? t : fallback;
}

function normalizeHandle(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v
    .trim()
    .replace(/^@/, '')
    .match(/^[A-Za-z0-9_]{1,15}$/);
  return m ? `@${m[0]}` : '';
}

/** Normalizes untrusted SEO settings (form/JSON) — unknown dropped, invalid → defaults. */
export function normalizeSeo(input: unknown): SeoSettings {
  const d = DEFAULT_EMBED_SETTINGS.seo;
  const o = asRecord(input);
  const og = asRecord(o['og']);
  const org = asRecord(o['org']);
  const jl = asRecord(o['jsonld']);
  const feed = asRecord(o['feed']);
  const an = asRecord(o['analytics']);
  const pt = jl['postingType'];
  const locale = typeof og['locale'] === 'string' ? og['locale'] : '';
  return {
    titleTemplate: str(o['titleTemplate'], d.titleTemplate, 200) || d.titleTemplate,
    description: str(o['description'], d.description, 500),
    keywords: str(o['keywords'], d.keywords, 400),
    robots: normalizeRobots(o['robots'], d.robots),
    canonicalBase: httpsUrl(o['canonicalBase'], d.canonicalBase),
    og: {
      siteName: str(og['siteName'], d.og.siteName, 120),
      locale: /^[a-z]{2}_[A-Z]{2}$/.test(locale) ? locale : d.og.locale,
      type: str(og['type'], d.og.type, 40),
      imageUrl: httpsUrl(og['imageUrl'], d.og.imageUrl),
      autoImage: bool(og['autoImage'], d.og.autoImage),
      twitterSite: normalizeHandle(og['twitterSite']),
    },
    org: {
      name: str(org['name'], d.org.name, 120),
      url: httpsUrl(org['url'], d.org.url),
      logoUrl: httpsUrl(org['logoUrl'], d.org.logoUrl),
      sameAs: str(org['sameAs'], d.org.sameAs, 1000),
    },
    jsonld: {
      website: bool(jl['website'], d.jsonld.website),
      organization: bool(jl['organization'], d.jsonld.organization),
      itemList: bool(jl['itemList'], d.jsonld.itemList),
      postings: bool(jl['postings'], d.jsonld.postings),
      postingType:
        pt === 'Article' || pt === 'SocialMediaPosting' || pt === 'DiscussionForumPosting'
          ? pt
          : d.jsonld.postingType,
      media: bool(jl['media'], d.jsonld.media),
    },
    feed: { enabled: bool(feed['enabled'], d.feed.enabled) },
    analytics: { scriptUrl: httpsUrl(an['scriptUrl'], d.analytics.scriptUrl) },
  };
}

/**
 * Normalizes untrusted input (form posts, stored JSON) into a valid
 * EmbedSettings — unknown fields dropped, invalid values replaced by defaults.
 */
export function normalizeEmbedSettings(input: unknown): EmbedSettings {
  const d = DEFAULT_EMBED_SETTINGS;
  const o = asRecord(input);
  const theme = asRecord(o['theme']);
  const filters = asRecord(o['filters']);
  const media = asRecord(o['media']);

  const modeRaw = theme['mode'];
  const mode =
    modeRaw === 'light' || modeRaw === 'dark' || modeRaw === 'auto' ? modeRaw : d.theme.mode;
  const layout = o['layout'] === 'grid' ? 'grid' : 'list';

  return {
    theme: {
      mode,
      colorAccent: color(theme['colorAccent'], d.theme.colorAccent),
      colorBackground: color(theme['colorBackground'], d.theme.colorBackground),
      colorText: color(theme['colorText'], d.theme.colorText),
    },
    layout,
    filters: {
      byType: bool(filters['byType'], d.filters.byType),
      byTime: bool(filters['byTime'], d.filters.byTime),
      search: bool(filters['search'], d.filters.search),
    },
    media: {
      text: bool(media['text'], d.media.text),
      image: bool(media['image'], d.media.image),
      video: bool(media['video'], d.media.video),
      voice: bool(media['voice'], d.media.voice),
      file: bool(media['file'], d.media.file),
      link: bool(media['link'], d.media.link),
    },
    seo: normalizeSeo(o['seo']),
  };
}

export interface EmbedInstance {
  id: string;
  name: string;
  settings: EmbedSettings;
  createdAt: string;
  updatedAt: string;
}

/** URL-safe random instance id (not guessable, but NOT a secret — it appears in host pages). */
export function newEmbedId(): string {
  return randomBytes(9).toString('base64url');
}

interface EmbedRow {
  id: string;
  name: string;
  settings: unknown;
  created_at: string;
  updated_at: string;
}

function toInstance(r: EmbedRow): EmbedInstance {
  return {
    id: r.id,
    name: r.name,
    settings: normalizeEmbedSettings(r.settings),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listEmbedInstances(db: Queryable): Promise<EmbedInstance[]> {
  const { rows } = await db.query<EmbedRow>(
    'SELECT id, name, settings, created_at, updated_at FROM embed_instances ORDER BY created_at',
  );
  return rows.map(toInstance);
}

export async function getEmbedInstance(db: Queryable, id: string): Promise<EmbedInstance | null> {
  const { rows } = await db.query<EmbedRow>(
    'SELECT id, name, settings, created_at, updated_at FROM embed_instances WHERE id = $1',
    [id],
  );
  return rows[0] ? toInstance(rows[0]) : null;
}

export async function createEmbedInstance(
  db: Queryable,
  name: string,
  settings: EmbedSettings = DEFAULT_EMBED_SETTINGS,
): Promise<EmbedInstance> {
  const id = newEmbedId();
  const { rows } = await db.query<EmbedRow>(
    `INSERT INTO embed_instances (id, name, settings)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, name, settings, created_at, updated_at`,
    [id, name, JSON.stringify(settings)],
  );
  const row = rows[0];
  if (!row) throw new Error('createEmbedInstance: no row returned');
  return toInstance(row);
}

export async function updateEmbedInstance(
  db: Queryable,
  id: string,
  name: string,
  settings: EmbedSettings,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE embed_instances SET name = $2, settings = $3::jsonb, updated_at = now() WHERE id = $1`,
    [id, name, JSON.stringify(settings)],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteEmbedInstance(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM embed_instances WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
