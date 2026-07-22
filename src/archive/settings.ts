/**
 * Archive publication settings (CCB-S3-007) — the operator's decision about
 * Cinderella's OWN messages, persisted under the `archive` key of the generic
 * `settings` table and edited in the admin console.
 *
 * These are deliberately not consent settings, and this file writes nothing to the
 * `consent` table. She is not a member giving consent; she is the operator's agent,
 * and the operator decides whether her side of a conversation is archived. Consent
 * keeps meaning exactly what it meant before: a member's own decision about their
 * own words.
 *
 * NOTHING HERE GATES ANYTHING BY ITSELF. The values are read by the SQL views in
 * migration 013 (`bot_publish_settings`), which is what keeps publication derived:
 * flipping a switch here changes what the public sees on the next read, everywhere
 * at once, with no backfill and no stored per-message flag to go stale. The
 * defaults below are duplicated in that view; `verify:admin-views` asserts the two
 * agree, so they cannot drift apart unnoticed.
 */

import { getSetting, setSetting } from '../db/settings.js';
import type { Queryable } from '../db/pool.js';
import { writeAudit } from '../db/audit.js';

/**
 * What kind of reply this was. The handler that produces a reply declares its
 * category, so a new plugin's replies arrive classified rather than defaulting
 * into the archive unclassified.
 */
export const REPLY_CATEGORIES = [
  'consent',
  'price',
  'search',
  'status',
  'help',
  'notUnderstood',
  'nickname',
  'disambiguation',
] as const;
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];

/** What to do when one of her messages names a member who has not opted in. */
export const MENTION_GUARDS = ['redact', 'withhold'] as const;
export type MentionGuard = (typeof MENTION_GUARDS)[number];

export interface ArchiveSettings {
  /**
   * Master switch for publishing her own messages. On by default (CCB-S3-007 §1):
   * a conversation with one side missing is the problem this feature exists to fix.
   */
  publishBotMessages: boolean;
  /**
   * How a reply naming a member who has not opted in is handled. `redact` keeps
   * the sentence and replaces the name; `withhold` drops the message entirely.
   */
  mentionGuard: MentionGuard;
  /** Per-category publication. A category missing here is treated as excluded. */
  categories: Record<ReplyCategory, boolean>;
}

/**
 * TWO OF THESE DEFAULTS DEPART FROM THE BRIEFING, and deliberately.
 *
 * CCB-S3-007 §3 lists "Status results" and "Price and search answers" as publish.
 * That table classifies replies by kind; it could not see what the strings
 * actually contain, and two of them carry member data that consent never covered:
 *
 *   status       "I keep {total} of your messages. {public} of them shine
 *                publicly, the rest rest quietly here with me."
 *                → publishes how many messages a member has that are NOT public.
 *                A member who never opted in has a private total, and this would
 *                put it on the web with a timestamp beside it.
 *
 *   searchResult "I found {n} moments where this group spoke of {query}."
 *                → {query} is up to 200 characters typed by the member. Publishing
 *                it republishes their words under her byline, with no consent
 *                anywhere in the path. It also makes her answer itself a search
 *                hit, so asking twice returns a larger number the second time.
 *
 * Both therefore ship EXCLUDED, and both stay switchable exactly as the briefing
 * requires — the operator can publish them, with the help text saying what they
 * are agreeing to. `help` is excluded as boilerplate she repeats.
 *
 * What remains on by default is her genuinely two-sided material: consent
 * confirmations (name-guarded) and price answers.
 */
export const DEFAULT_ARCHIVE: ArchiveSettings = {
  publishBotMessages: true,
  mentionGuard: 'redact',
  categories: {
    consent: true,
    price: true,
    search: false,
    status: false,
    help: false,
    notUnderstood: false,
    nickname: false,
    disambiguation: false,
  },
};

/** Operator-facing description of each category, shown beside its switch. */
export const CATEGORY_LABELS: Record<ReplyCategory, { label: string; help: string }> = {
  consent: {
    label: 'Consent confirmations and results',
    help: 'Her side of an opt-in or opt-out: the confirmation question, the result, an undo, and a refusal to act for somebody else.',
  },
  price: {
    label: 'Price answers',
    help: 'Market-data answers from the Crypto Prices plugin, including "I could not reach a provider".',
  },
  search: {
    label: 'Search answers',
    help: 'Excluded by default: her answer repeats the words the member searched for, which publishes their text without their consent.',
  },
  status: {
    label: 'Status results',
    help: 'Excluded by default: the answer says how many of a member’s messages are NOT public, which is private even when their name is redacted.',
  },
  help: {
    label: 'Help text',
    help: 'The "here is what you can ask me" reply. Boilerplate she repeats often — excluded by default.',
  },
  notUnderstood: {
    label: 'Not-understood prompts',
    help: '"I did not quite catch that." Excluded by default: it records a failure, not a conversation.',
  },
  nickname: {
    label: 'Nickname retorts',
    help: 'Her answer to being called Aschenputtel. Excluded by default — a snub, not archive content.',
  },
  disambiguation: {
    label: 'Disambiguation questions',
    help: '"Which HEX did you mean?" Excluded by default: the answer that follows carries the meaning.',
  },
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

/**
 * Normalizes untrusted admin input. Every category is written out explicitly —
 * a partial map would leave the SQL side falling back per key, and two places
 * deciding the same default is exactly how they drift apart.
 */
export function normalizeArchive(input: unknown): ArchiveSettings {
  const d = DEFAULT_ARCHIVE;
  const o = rec(input);
  const cats = rec(o['categories']);
  const categories = {} as Record<ReplyCategory, boolean>;
  for (const c of REPLY_CATEGORIES) categories[c] = bool(cats[c], d.categories[c]);

  const rawGuard = o['mentionGuard'];
  const guard = typeof rawGuard === 'string' ? rawGuard.trim() : '';
  return {
    publishBotMessages: bool(o['publishBotMessages'], d.publishBotMessages),
    mentionGuard: (MENTION_GUARDS as readonly string[]).includes(guard)
      ? (guard as MentionGuard)
      : d.mentionGuard,
    categories,
  };
}

/**
 * Would a reply of this category be published right now? The public archive does
 * NOT consult this — the SQL view is the gate. It exists so the capture side can
 * skip storing a reply nobody will ever publish, and so the admin can show what a
 * category currently does.
 */
export function categoryPublishes(s: ArchiveSettings, category: ReplyCategory | null): boolean {
  if (!s.publishBotMessages || !category) return false;
  return s.categories[category] === true;
}

const ARCHIVE_KEY = 'archive';

/** In-process cache of the archive settings, refreshed on write. */
export class ArchiveService {
  private constructor(
    private readonly db: Queryable,
    private current: ArchiveSettings,
  ) {}

  static async load(db: Queryable): Promise<ArchiveService> {
    const stored = await getSetting(db, ARCHIVE_KEY);
    return new ArchiveService(db, normalizeArchive(stored ?? {}));
  }

  /** All-defaults service, for harnesses and as a server fallback. */
  static withDefaults(db: Queryable): ArchiveService {
    return new ArchiveService(db, normalizeArchive({}));
  }

  get(): ArchiveSettings {
    return this.current;
  }

  /**
   * Accepts `unknown` on purpose: everything reaching it comes from an admin
   * form, and `normalizeArchive` is the thing that makes it a settings object.
   * Typing the parameter as `ArchiveSettings` would only have moved the cast to
   * the caller, where it would assert something nobody had checked yet.
   */
  async save(next: unknown, actor: string): Promise<void> {
    const normalized = normalizeArchive(next);
    await setSetting(this.db, ARCHIVE_KEY, normalized);
    await writeAudit(this.db, actor, 'archive.update', 'archive', normalized);
    this.current = normalized;
  }
}
