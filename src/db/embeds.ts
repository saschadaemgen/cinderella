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
