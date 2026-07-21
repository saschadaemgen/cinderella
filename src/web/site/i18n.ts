/**
 * Website internationalization (CCB-S2-012).
 *
 * Locale files live in `locales/<code>.json`, keyed by string id. All visible site
 * copy comes from the active locale. Adding a language is a FILE, not code: drop a
 * new `locales/xx.json` in place (with an `_meta` block) and it is picked up at
 * startup — per-language URLs, the switcher and hreflang all derive from the loaded
 * set. English is the primary/default language.
 *
 * The loader is synchronous (readFileSync) so route registration + the public-path
 * predicate can be built during buildServer without an async barrier.
 *
 * Resilience (CCB-S2-012 review): the loader NEVER throws. The doctrine invites
 * non-developers to edit these files, and this one process also hosts the admin
 * console and the consent-capture worker — a stray comma in a marketing-copy file
 * must not take the whole product down. A malformed/unreadable locale file is
 * skipped with a warning; if even the primary is missing it is synthesized (empty),
 * so `t()` degrades to visible key ids rather than a crashed process.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../log.js';

export interface LocaleMeta {
  code: string;
  /** Endonym shown in the language switcher (e.g. "English", "Deutsch"). */
  name: string;
  /** Open Graph locale (e.g. "en_US"). */
  ogLocale: string;
  /** Text direction ("ltr" | "rtl"). */
  dir: string;
}

export interface LocaleSet {
  /** Supported locale codes, DEFAULT FIRST, then the rest alphabetically. */
  codes: string[];
  /** The default/primary locale code (English unless overridden). */
  default: string;
  meta: Record<string, LocaleMeta>;
  has(code: string): boolean;
  /** Resolve a key for a locale, falling back to the default locale then the key. */
  t(code: string, key: string, vars?: Record<string, string | number>): string;
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

function readMeta(code: string, raw: Record<string, unknown>): LocaleMeta {
  const m = (raw['_meta'] ?? {}) as Record<string, unknown>;
  const str = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d);
  return {
    code,
    name: str(m['name'], code.toUpperCase()),
    ogLocale: str(m['ogLocale'], `${code}_${code.toUpperCase()}`),
    dir: m['dir'] === 'rtl' ? 'rtl' : 'ltr',
  };
}

/**
 * Loads every `locales/*.json` from `dir`. NEVER throws (see the resilience note
 * above): a bad file is skipped with a warning; a missing primary is synthesized.
 * Codes are lowercased so a mis-cased `De.json` still matches lowercasing
 * negotiation (`de`).
 */
export function loadLocales(dir: string, primary = 'en'): LocaleSet {
  const dicts: Record<string, Record<string, string>> = {};
  const meta: Record<string, LocaleMeta> = {};
  let declaredDefault: string | null = null;

  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch (err) {
    log.error(`Locales directory ${dir} is unreadable (${(err as Error).message}).`);
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const code = file.slice(0, -'.json'.length).toLowerCase();
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(code)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      // Skip — a malformed locale file must not crash the process (admin + capture).
      log.warn(`Skipping invalid locale file ${file}: ${(err as Error).message}`);
      continue;
    }
    const dict: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k === '_meta') continue;
      if (typeof v === 'string') dict[k] = v;
    }
    dicts[code] = dict;
    meta[code] = readMeta(code, parsed);
    const m = parsed['_meta'] as Record<string, unknown> | undefined;
    if (m && m['default'] === true) declaredDefault = code;
  }

  if (!dicts[primary]) {
    // The primary is the site's floor; synthesize an empty one rather than crash the
    // whole process — `t()` then returns key ids as a loud signal to fix the file.
    log.error(
      `Primary locale "${primary}.json" missing/invalid in ${dir}; the marketing site will render string ids until it is fixed.`,
    );
    dicts[primary] = {};
    meta[primary] = readMeta(primary, {});
  }
  const def = declaredDefault && dicts[declaredDefault] ? declaredDefault : primary;
  const rest = Object.keys(dicts)
    .filter((c) => c !== def)
    .sort();
  const codes = [def, ...rest];

  return {
    codes,
    default: def,
    meta,
    has: (code) => Object.prototype.hasOwnProperty.call(dicts, code),
    t(code, key, vars) {
      const fromLocale = dicts[code]?.[key];
      const value = fromLocale ?? dicts[def]?.[key] ?? key;
      return interpolate(value, vars);
    },
  };
}
