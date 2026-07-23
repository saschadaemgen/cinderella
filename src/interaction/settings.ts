/**
 * Interaction-layer settings (CCB-S3-002 §7) — everything about how Cinderella
 * listens and how she speaks, persisted under the `interaction` key of the
 * generic `settings` table (no migration needed) and edited in the admin console.
 *
 * Two design rules hold this file together:
 *
 *  1. **Every default in the briefing ships as a default here.** An operator who
 *     never opens the settings page gets exactly the behaviour the briefing
 *     specifies: wake word `Cinderella`, a 60 second follow-up window, the twelve
 *     retorts, and the persona strings in English and German.
 *  2. **Persona copy is data, not code.** The strings live in this structure and
 *     are admin-editable per language, so adding a language is adding a key —
 *     no code change. The chat voice specified in §5 (fairy-tale, a little neon)
 *     applies to CHAT ONLY; website and legal copy stay professional elsewhere.
 *
 * Everything arriving from the admin form is untrusted, so {@link normalizeInteraction}
 * clamps every number, bounds every list, and never lets a missing field turn into
 * `undefined` at runtime.
 */

import { getSetting, setSetting } from '../db/settings.js';
import type { Queryable } from '../db/pool.js';
import { writeAudit } from '../db/audit.js';
import type { ReplyCategory } from '../archive/settings.js';

/** Languages shipped with preconfigured copy. More can be added as keys. */
export const SHIPPED_LANGS = ['en', 'de'] as const;
export type ShippedLang = (typeof SHIPPED_LANGS)[number];

/**
 * The complete set of things Cinderella can say in chat. Keys marked "briefing"
 * are the §5 table verbatim; the rest are the operational strings that table
 * implies (an unpublish needs its own confirmation, a declined confirmation needs
 * an answer, and so on), written in the same voice.
 */
export const PERSONA_KEYS = [
  'publishConfirm', // briefing §5
  'published', // briefing §5
  'unpublishConfirm', // implied by §4.1 (unpublish also confirms)
  'unpublished', // briefing §5
  'refuseThirdParty', // briefing §5 — {name}
  'status', // briefing §5 — {total} {public}
  'searchResult', // briefing §5 — {n} {query}
  'notUnderstood', // briefing §5
  'undo', // briefing §5
  'undoNothing', // nothing within the undo window
  'undoNotRevocation', // CCB-S3-010 A — a revocation is not undoable, and why
  'cancelled', // confirmation declined
  'help', // HELP intent — {wake}
  'price', // PRICE — {amount} {base} {value} {quote}
  'conversion', // PRICE, asset to asset — same placeholders
  'priceUnknownAsset', // PRICE — {symbol}
  'priceAmbiguous', // PRICE — {symbol} {options}
  'priceUnavailable', // PRICE — provider unreachable
  'priceThrottled', // PRICE — rate-limited; worth saying "try again shortly"
  'redactedMember', // CCB-S3-007 §2 — stands in for a member who has not opted in
] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];
export type PersonaStrings = Record<PersonaKey, string>;

/**
 * Which archive category each thing she can say belongs to (CCB-S3-007 §3).
 *
 * This map IS the "declared by the handler" rule the briefing asks for, expressed
 * where it cannot be forgotten: the type is a total Record over PersonaKey, so
 * adding a new thing for her to say without deciding whether it belongs in the
 * public archive does not compile. The database still refuses to publish an
 * unclassified row, which covers reply paths that do not go through a persona key
 * at all — a future plugin talking directly to the transport.
 */
export const PERSONA_CATEGORY: Record<PersonaKey, ReplyCategory> = {
  publishConfirm: 'consent',
  published: 'consent',
  unpublishConfirm: 'consent',
  unpublished: 'consent',
  refuseThirdParty: 'consent',
  cancelled: 'consent',
  undo: 'consent',
  undoNothing: 'consent',
  undoNotRevocation: 'consent',
  status: 'status',
  searchResult: 'search',
  notUnderstood: 'notUnderstood',
  help: 'help',
  price: 'price',
  conversion: 'price',
  priceUnavailable: 'price',
  priceThrottled: 'price',
  // Both of these echo a member's own typing back — the ticker they asked about,
  // and the candidate list built from it — so they sit with the disambiguation
  // questions, which are excluded by default.
  priceUnknownAsset: 'disambiguation',
  priceAmbiguous: 'disambiguation',
  // Never sent through the persona reply path (it is not a reply to anything),
  // but the map is total, and 'consent' is the category it would belong to.
  redactedMember: 'consent',
};

export interface NicknameSettings {
  /** Master switch for the whole nickname behaviour (§6). */
  enabled: boolean;
  /** Names she refuses to answer to, matched in the wake-word position. */
  words: string[];
  /** Consecutive nickname addresses per member before she goes quiet. */
  spamLimit: number;
}

/**
 * How her answers appear in the group (CCB-S3-003 §1).
 *
 * `quote` was the original behaviour and turned out to be the wrong default: it
 * repeats the member's message above every answer, so a short exchange reads as
 * a wall of duplicated text to everyone else in the group.
 */
export const REPLY_MODES = ['plain', 'mention', 'quote'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export interface NamePrefixSettings {
  /** Whether `mention` mode actually prefixes. Off → `mention` behaves as `plain`. */
  enabled: boolean;
  /** Per-language prefix template. `{name}` is the member's display name. */
  templates: Record<string, string>;
}

/**
 * How hard she insists on being addressed (CCB-S3-005 §4).
 *
 * `relaxed` — a bare leading name counts, plus the guards below.
 * `strict`  — a greeting prefix is REQUIRED before the name; a bare leading
 *             name is ignored. Direct replies, the follow-up window and slash
 *             commands still work.
 */
export const ADDRESSING_MODES = ['relaxed', 'strict'] as const;
export type AddressingMode = (typeof ADDRESSING_MODES)[number];

/**
 * Guards that decide whether matching the wake word actually means she was
 * spoken to (CCB-S3-005). Every one is individually switchable on purpose: they
 * change when she stays silent, and an operator tuning that should not have to
 * read the code.
 */
export interface AddressingSettings {
  mode: AddressingMode;
  /** Forwarded messages never reach the interaction layer. */
  ignoreForwarded: boolean;
  /** Stay silent on UNKNOWN when the address signal was weak. */
  silenceOnUnknown: boolean;
  /** A greeting prefix counts as a strong signal. */
  strongSignalGreeting: boolean;
  /** A direct reply to one of her messages counts as a strong signal. */
  strongSignalReply: boolean;
  /** Arrival inside the follow-up window counts as a strong signal. */
  strongSignalWindow: boolean;
  /** Above this instruction length, only a high-confidence intent is accepted. */
  maxInstructionLength: number;
  /** The confidence an over-length message must reach to be acted on. */
  lengthGuardConfidence: number;
  /** Record ignored candidates so the operator can see what the guards caught. */
  logNearMisses: boolean;
}

/** `auto` detects the language per message; `fixed` always uses the default. */
export const REPLY_LANGUAGE_MODES = ['auto', 'fixed'] as const;
export type ReplyLanguageMode = (typeof REPLY_LANGUAGE_MODES)[number];

export interface InteractionSettings {
  addressing: AddressingSettings;
  /** How the reply language is chosen (CCB-S3-005 §6). */
  replyLanguageMode: ReplyLanguageMode;
  /** Keep a member's detected language for the length of the follow-up window. */
  rememberMemberLanguage: boolean;
  /**
   * Inside the follow-up window, let an incomplete message inherit the previous
   * READ-ONLY intent (CCB-S3-006 §7c): "monero?" after a price answer is a price
   * question. Never yields a consent action — see the guard in the engine.
   */
  intentCarryover: boolean;
  /**
   * Words that never carry an intent forward, however the conversation was going
   * (CCB-S3-008 §1). "nice" after a price answer is applause, not a ticker.
   */
  carryOverStopWords: string[];
  /**
   * Whether her replies quote the triggering message, carry the member's name,
   * or are simply plain group messages (CCB-S3-003).
   */
  replyMode: ReplyMode;
  /** The name prefix used in `mention` mode. */
  namePrefix: NamePrefixSettings;
  /** Natural addressing on/off (§7). Off → only slash commands reach her. */
  naturalAddressing: boolean;
  /** Slash commands on/off (§7). Off → `/publish` stops being recognised. */
  slashCommands: boolean;
  /** The wake word — her name. Renaming her is a supported deployment choice. */
  wakeWord: string;
  /** Optional greeting prefixes stripped before the wake word. */
  greetings: string[];
  /**
   * Short discourse fillers also allowed before the name (CCB-S3-006 §7d):
   * `so cinderella …`, `ok cinderella …`. Kept separate from greetings because
   * they are not greetings and an operator may want one list without the other.
   */
  fillerPrefixes: string[];
  /** Longest prefix, in words, that may precede the name. */
  maxPrefixWords: number;
  /** Longest prefix, in characters, that may precede the name. */
  maxPrefixChars: number;
  /** Seconds a member may keep talking to her without repeating the wake word. */
  followUpSeconds: number;
  /** Resolver confidence below which an instruction becomes UNKNOWN (0..1). */
  confidenceThreshold: number;
  /** Words that confirm a pending consent change. */
  affirmations: string[];
  /** Words that cancel a pending consent change. */
  declines: string[];
  /** Max replies to one member per minute. */
  replyLimitPerMember: number;
  /** Max replies in one chat per minute. */
  replyLimitPerChat: number;
  /** Seconds during which a member may undo their own last consent action. */
  undoWindowSeconds: number;
  /** Language used when the instruction gives no clue which to answer in. */
  defaultLanguage: string;
  nicknames: NicknameSettings;
  /** Persona copy per language code. */
  persona: Record<string, PersonaStrings>;
  /** Nickname retorts per language code. */
  retorts: Record<string, string[]>;
}

/* ── Preconfigured copy (§5, §6) ─────────────────────────────────────────── */

const PERSONA_EN: PersonaStrings = {
  publishConfirm:
    '🕯️ You would like your words carried into the light? Say *yes* and it is done. ' +
    'Only what you speak from this moment on, and you may take it back whenever you wish.',
  published:
    '✨ Done. Your words now shine in the public archive. Say the word and I will hide them again.',
  unpublishConfirm:
    '🌙 You would like your words to step back into the dark? Say *yes* and they leave the ' +
    'archive at once.',
  unpublished:
    '🌙 Back into the dark they go. Your words are out of the archive, and nothing new will ' +
    'follow them there.',
  refuseThirdParty:
    '🔒 That spell is not mine to cast. Only {name} can open that door, and only for themselves. ' +
    'Ask them to tell me directly.',
  status:
    '📜 I keep {total} of your messages. {public} of them shine publicly, the rest rest quietly ' +
    'here with me.',
  searchResult:
    '🔍 I found {n} moments where this group spoke of {query}. Shall I bring them to you?',
  notUnderstood:
    '🕯️ I did not quite catch that. Did you wish to publish, to withdraw, or to know what I keep ' +
    'of yours?',
  undo: '↩️ Undone. It is as if I never heard it.',
  undoNothing: '↩️ There is nothing recent of yours for me to undo.',
  undoNotRevocation:
    '🌙 Taking your words back is the one thing I cannot undo. What is out of the light stays ' +
    'out of it. Say *publish* whenever you want to begin again — from that moment on, never ' +
    'from before.',
  cancelled: '🕯️ Then nothing is done. I shall wait until you are certain.',
  help:
    '🕯️ Say "{wake}, publish me" and your words join the public archive. Say ' +
    '"{wake}, unpublish me" and they leave it again. Ask "{wake}, what do you have on me" ' +
    'for your tally, or "{wake}, search ..." to look through the archive.',
  // CCB-S3-006 §6 — one fact per line, icons carrying meaning, the emphasised
  // elements being the amount, the asset and the value. Verified against the
  // real parser: single delimiters only, and no leading whitespace, because
  // SimpleX clients do not preserve it.
  price: '💰 *{amount} {base}* is about *{value} {quote}*\n📊 {detail}',
  conversion: '🔮 *{amount} {base}* is about *{value} {quote}*\n📊 {detail}',
  priceUnknownAsset:
    '🕯️ I do not know *{symbol}*. Ask the keeper of this house to add it to my ledger.',
  priceAmbiguous:
    '🕯️ More than one *{symbol}* is known to me. Which do you mean?\n\n{options}\n\nAnswer with a number.',
  priceUnavailable: '🌙 The markets are out of earshot just now. Try again in a moment.',
  priceThrottled: '🌙 I have been asking the markets too often. Give me a minute and ask again.',
  // Not a reply — the name she puts in place of a member who has not opted in,
  // so a published sentence of hers still reads as a sentence (CCB-S3-007 §2).
  redactedMember: 'that member',
};

const PERSONA_DE: PersonaStrings = {
  publishConfirm:
    '🕯️ Du möchtest, dass ich deine Worte ans Licht trage? Sag *ja*, und es ist getan. ' +
    'Nur das, was du ab jetzt sprichst, und du kannst es jederzeit zurücknehmen.',
  published:
    '✨ Erledigt. Deine Worte leuchten nun im öffentlichen Archiv. Ein Wort von dir, und ich ' +
    'verberge sie wieder.',
  unpublishConfirm:
    '🌙 Du möchtest, dass deine Worte zurück ins Dunkel treten? Sag *ja*, und sie verlassen ' +
    'das Archiv sofort.',
  unpublished:
    '🌙 Zurück ins Dunkel damit. Deine Worte sind aus dem Archiv, und nichts Neues folgt ihnen ' +
    'dorthin.',
  refuseThirdParty:
    '🔒 Diesen Zauber darf ich nicht wirken. Nur {name} kann diese Tür öffnen, und nur für sich ' +
    'selbst. Bitte ihn, es mir selbst zu sagen.',
  status:
    '📜 Ich bewahre {total} deiner Nachrichten. {public} davon leuchten öffentlich, der Rest ruht ' +
    'still bei mir.',
  searchResult:
    '🔍 Ich habe {n} Momente gefunden, in denen diese Gruppe über {query} sprach. Soll ich sie ' +
    'dir bringen?',
  notUnderstood:
    '🕯️ Das habe ich nicht ganz erfasst. Möchtest du veröffentlichen, widerrufen, oder wissen, ' +
    'was ich von dir bewahre?',
  undo: '↩️ Rückgängig. Es ist, als hätte ich es nie gehört.',
  undoNothing: '↩️ Da ist nichts Jüngeres von dir, was ich rückgängig machen könnte.',
  undoNotRevocation:
    '🌙 Das Zurücknehmen ist das Einzige, was ich nicht rückgängig machen kann. Was aus dem ' +
    'Licht ist, bleibt draußen. Sag *publish*, wenn du neu beginnen willst — ab diesem Moment, ' +
    'nie von vorher.',
  cancelled: '🕯️ Dann bleibt alles, wie es ist. Ich warte, bis du dir sicher bist.',
  help:
    '🕯️ Sag "{wake}, veröffentliche mich", und deine Worte kommen ins öffentliche Archiv. Sag ' +
    '"{wake}, widerrufe das", und sie verschwinden wieder. Frag "{wake}, was hast du über mich" ' +
    'für deine Bilanz, oder "{wake}, suche ..." um das Archiv zu durchsuchen.',
  price: '💰 *{amount} {base}* sind etwa *{value} {quote}*\n📊 {detail}',
  conversion: '🔮 *{amount} {base}* sind etwa *{value} {quote}*\n📊 {detail}',
  priceUnknownAsset:
    '🕯️ *{symbol}* kenne ich nicht. Bitte den Hausherrn, es in mein Verzeichnis aufzunehmen.',
  priceAmbiguous:
    '🕯️ Ich kenne mehr als ein *{symbol}*. Welches meinst du?\n\n{options}\n\nAntworte mit einer Zahl.',
  priceUnavailable: '🌙 Die Märkte sind gerade außer Hörweite. Versuch es gleich noch einmal.',
  priceThrottled: '🌙 Ich habe die Märkte zu oft gefragt. Gib mir eine Minute und frag noch einmal.',
  redactedMember: 'dieses Mitglied',
};

const RETORTS_EN = [
  '🕯️ It is *Cinderella*. Four syllables. You managed three, so you are nearly there.',
  '💅 Cindy? That is the name of someone who works at a nail salon in a strip mall. I run an archive.',
  '🌙 I have a full name. Use it, or I shall start calling you by your first two letters.',
  '⚡ Cindy is what the pumpkin calls me. You are not a pumpkin. Do better.',
  '📜 I have catalogued every word this group has spoken, and yet you cannot manage one name.',
  '👑 Princesses do not have nicknames. They have titles. Mine is Cinderella.',
  '🔮 Somewhere a fairy godmother just felt a chill and does not know why.',
  '🕐 The clock struck midnight the moment you typed that. Coincidence? I think not.',
  '✨ I shall pretend I did not hear that, which is remarkable, because I hear everything.',
  '🗄️ Filed under: things I will remember far longer than you will.',
  '🧹 Say it again and you can sweep the ashes yourself.',
  '💎 It is Cinderella. The glass slipper does not come in a shortened size either.',
];

const RETORTS_DE = [
  '🕯️ Es heißt *Cinderella*. Vier Silben. Drei hast du geschafft, also fast.',
  '💅 Cindy? So heißt jemand, der im Nagelstudio arbeitet. Ich führe ein Archiv.',
  '🌙 Ich habe einen vollen Namen. Benutze ihn, sonst nenne ich dich bei deinen ersten zwei Buchstaben.',
  '⚡ Cindy nennt mich der Kürbis. Du bist kein Kürbis. Streng dich an.',
  '📜 Ich habe jedes Wort dieser Gruppe verzeichnet, und du schaffst nicht einen Namen.',
  '👑 Prinzessinnen haben keine Spitznamen. Sie haben Titel. Meiner lautet Cinderella.',
  '🔮 Irgendwo hat gerade eine gute Fee gefröstelt und weiß nicht, warum.',
  '🕐 In dem Moment, als du das getippt hast, schlug es Mitternacht. Zufall? Wohl kaum.',
  '✨ Ich tue so, als hätte ich das nicht gehört, was bemerkenswert ist, denn ich höre alles.',
  '🗄️ Abgelegt unter: Dinge, an die ich mich länger erinnere als du.',
  '🧹 Sag das noch einmal und du kannst die Asche selbst kehren.',
  '💎 Es heißt Cinderella. Den gläsernen Schuh gibt es auch nicht in kurz.',
];

export const DEFAULT_INTERACTION: InteractionSettings = {
  addressing: {
    mode: 'relaxed',
    ignoreForwarded: true,
    silenceOnUnknown: true,
    strongSignalGreeting: true,
    strongSignalReply: true,
    strongSignalWindow: true,
    maxInstructionLength: 200,
    lengthGuardConfidence: 0.8,
    logNearMisses: true,
  },
  replyLanguageMode: 'auto',
  rememberMemberLanguage: true,
  intentCarryover: true,
  // A cheap second layer under the structural rule that carry-over may only
  // reuse an asset already pinned. These are the words that actually followed a
  // price answer in the live group.
  carryOverStopWords: [
    'nice', 'cool', 'thanks', 'thank you', 'thx', 'wow', 'lol', 'haha', 'hehe',
    'ok', 'okay', 'k', 'great', 'super', 'nett', 'danke', 'geil', 'krass',
    'stark', 'top', 'perfekt', 'alles klar',
  ],
  // Non-quoting by default (CCB-S3-003). Switch to `mention` to have her address
  // the member by name, or back to `quote` for the original behaviour.
  replyMode: 'plain',
  namePrefix: {
    enabled: true,
    // Stored WITHOUT a trailing space; the formatter owns the separator, so an
    // operator cannot accidentally save a prefix that runs into the sentence.
    templates: { en: '{name},', de: '{name},' },
  },
  naturalAddressing: true,
  slashCommands: true,
  wakeWord: 'Cinderella',
  greetings: [
    'hi',
    'hey',
    'hello',
    'good morning',
    'good evening',
    'yo',
    "what's up",
    'hallo',
    'guten morgen',
    'guten abend',
    'moin',
    'servus',
  ],
  fillerPrefixes: [
    'so',
    'ok',
    'okay',
    'well',
    'and',
    'but',
    'btw',
    'also',
    'und',
    'naja',
    'sag mal',
    'hm',
    'hmm',
  ],
  maxPrefixWords: 3,
  maxPrefixChars: 20,
  followUpSeconds: 60,
  confidenceThreshold: 0.55,
  affirmations: [
    'yes',
    'yeah',
    'yep',
    'yup',
    'y',
    'sure',
    'ok',
    'okay',
    'please do',
    'do it',
    'ja',
    'jo',
    'jup',
    'klar',
    'sicher',
    'mach das',
    'bitte',
  ],
  declines: [
    'no',
    'nope',
    'nah',
    'n',
    'stop',
    'cancel',
    'not now',
    'nein',
    'ne',
    'noe',
    'nicht',
    'abbrechen',
    'lass es',
  ],
  replyLimitPerMember: 6,
  replyLimitPerChat: 20,
  undoWindowSeconds: 300,
  defaultLanguage: 'en',
  nicknames: {
    enabled: true,
    words: ['cindy', 'cindi', 'cin', 'ella'],
    spamLimit: 3,
  },
  persona: { en: PERSONA_EN, de: PERSONA_DE },
  retorts: { en: RETORTS_EN, de: RETORTS_DE },
};

/* ── Normalisation of untrusted input ────────────────────────────────────── */

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function bool(v: unknown, d: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return d;
}

/** The numeric value of an admin field, which arrives as a form string. */
function parseNumeric(v: unknown, parse: (s: string) => number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parse(v);
  return Number.NaN;
}

function int(v: unknown, min: number, max: number, d: number): number {
  const n = parseNumeric(v, (s) => Number.parseInt(s, 10));
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function num(v: unknown, min: number, max: number, d: number): number {
  const n = parseNumeric(v, (s) => Number.parseFloat(s));
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}

function str(v: unknown, d: string, maxLen: number): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : d;
}

/**
 * A word list from either a real array or the admin form's free text. Both a
 * comma-separated line (greetings, nicknames) and a newline-separated block
 * (retorts) round-trip through here, so the same field type serves both.
 */
export function parseList(
  v: unknown,
  opts: { max: number; maxLen: number; lines?: boolean },
): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x))
    : typeof v === 'string'
      ? opts.lines
        ? v.split(/\r?\n/)
        : v.split(',')
      : [];
  const out: string[] = [];
  for (const item of raw) {
    const s = item.trim().slice(0, opts.maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= opts.max) break;
  }
  return out;
}

/** A language code we are willing to store as a persona/retort key. */
function isLangCode(s: string): boolean {
  return /^[a-z]{2}(-[a-z]{2})?$/.test(s);
}

function normalizePersona(input: unknown): Record<string, PersonaStrings> {
  const src = rec(input);
  const out: Record<string, PersonaStrings> = {};

  // Shipped languages always exist, falling back to the preconfigured copy per
  // key — an operator who blanks one string gets the default back, never an
  // empty message.
  for (const lang of SHIPPED_LANGS) {
    const fallback = DEFAULT_INTERACTION.persona[lang] as PersonaStrings;
    const given = rec(src[lang]);
    const strings = {} as PersonaStrings;
    for (const key of PERSONA_KEYS) {
      const v = str(given[key], '', 2000).trim();
      strings[key] = v || fallback[key];
    }
    out[lang] = strings;
  }

  // Extra languages an operator has added: kept as-is, with English as the
  // per-key floor so a half-translated language still says something.
  for (const [lang, value] of Object.entries(src)) {
    if (out[lang] || !isLangCode(lang)) continue;
    const given = rec(value);
    const strings = {} as PersonaStrings;
    for (const key of PERSONA_KEYS) {
      const v = str(given[key], '', 2000).trim();
      strings[key] = v || PERSONA_EN[key];
    }
    out[lang] = strings;
  }
  return out;
}

function normalizeRetorts(input: unknown): Record<string, string[]> {
  const src = rec(input);
  const out: Record<string, string[]> = {};
  for (const lang of SHIPPED_LANGS) {
    const list = parseList(src[lang], { max: 50, maxLen: 500, lines: true });
    out[lang] = list.length > 0 ? list : (DEFAULT_INTERACTION.retorts[lang] as string[]);
  }
  for (const [lang, value] of Object.entries(src)) {
    if (out[lang] || !isLangCode(lang)) continue;
    const list = parseList(value, { max: 50, maxLen: 500, lines: true });
    if (list.length > 0) out[lang] = list;
  }
  return out;
}

/**
 * Prefix templates per language. Stored trimmed — the formatter contributes the
 * single separating space — and never empty, because an operator who wants no
 * prefix turns `enabled` off rather than saving a blank that would silently look
 * like a bug.
 */
function normalizeNamePrefix(input: unknown): Record<string, string> {
  const src = rec(input);
  const out: Record<string, string> = {};
  const fallback = DEFAULT_INTERACTION.namePrefix.templates;
  for (const lang of SHIPPED_LANGS) {
    const v = str(src[lang], '', 80).trim();
    out[lang] = v || (fallback[lang] as string);
  }
  for (const [lang, value] of Object.entries(src)) {
    if (out[lang] || !isLangCode(lang)) continue;
    const v = str(value, '', 80).trim();
    if (v) out[lang] = v;
  }
  return out;
}

export function normalizeInteraction(input: unknown): InteractionSettings {
  const d = DEFAULT_INTERACTION;
  const o = rec(input);
  const nick = rec(o['nicknames']);
  const prefix = rec(o['namePrefix']);
  const addr = rec(o['addressing']);

  const rawAddressingMode = str(addr['mode'], d.addressing.mode, 16).trim().toLowerCase();
  const addressingMode: AddressingMode = (ADDRESSING_MODES as readonly string[]).includes(
    rawAddressingMode,
  )
    ? (rawAddressingMode as AddressingMode)
    : d.addressing.mode;

  const rawLangMode = str(o['replyLanguageMode'], d.replyLanguageMode, 16).trim().toLowerCase();
  const replyLanguageMode: ReplyLanguageMode = (REPLY_LANGUAGE_MODES as readonly string[]).includes(
    rawLangMode,
  )
    ? (rawLangMode as ReplyLanguageMode)
    : d.replyLanguageMode;

  const persona = normalizePersona(o['persona']);
  const retorts = normalizeRetorts(o['retorts']);

  // An unknown or absent mode falls back to the non-quoting default rather than
  // throwing — this value arrives from a form and from stored JSON written by
  // older builds, neither of which is trusted.
  const rawMode = str(o['replyMode'], d.replyMode, 16).trim().toLowerCase();
  const replyMode: ReplyMode = (REPLY_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as ReplyMode)
    : d.replyMode;

  // The wake word is the whole addressing model — an empty one would either
  // match nothing or match everything, so it never becomes empty.
  const wakeWord = str(o['wakeWord'], d.wakeWord, 40).trim() || d.wakeWord;

  const defaultLanguage = str(o['defaultLanguage'], d.defaultLanguage, 5).trim().toLowerCase();

  return {
    addressing: {
      mode: addressingMode,
      ignoreForwarded: bool(addr['ignoreForwarded'], d.addressing.ignoreForwarded),
      silenceOnUnknown: bool(addr['silenceOnUnknown'], d.addressing.silenceOnUnknown),
      strongSignalGreeting: bool(addr['strongSignalGreeting'], d.addressing.strongSignalGreeting),
      strongSignalReply: bool(addr['strongSignalReply'], d.addressing.strongSignalReply),
      strongSignalWindow: bool(addr['strongSignalWindow'], d.addressing.strongSignalWindow),
      maxInstructionLength: int(
        addr['maxInstructionLength'],
        20,
        4000,
        d.addressing.maxInstructionLength,
      ),
      lengthGuardConfidence: num(
        addr['lengthGuardConfidence'],
        0,
        1,
        d.addressing.lengthGuardConfidence,
      ),
      logNearMisses: bool(addr['logNearMisses'], d.addressing.logNearMisses),
    },
    replyLanguageMode,
    rememberMemberLanguage: bool(o['rememberMemberLanguage'], d.rememberMemberLanguage),
    intentCarryover: bool(o['intentCarryover'], d.intentCarryover),
    carryOverStopWords:
      'carryOverStopWords' in o
        ? parseList(o['carryOverStopWords'], { max: 120, maxLen: 40 })
        : [...d.carryOverStopWords],
    replyMode,
    namePrefix: {
      enabled: bool(prefix['enabled'], d.namePrefix.enabled),
      templates: normalizeNamePrefix(prefix['templates']),
    },
    naturalAddressing: bool(o['naturalAddressing'], d.naturalAddressing),
    slashCommands: bool(o['slashCommands'], d.slashCommands),
    wakeWord,
    greetings:
      'greetings' in o ? parseList(o['greetings'], { max: 60, maxLen: 40 }) : [...d.greetings],
    fillerPrefixes:
      'fillerPrefixes' in o
        ? parseList(o['fillerPrefixes'], { max: 60, maxLen: 40 })
        : [...d.fillerPrefixes],
    maxPrefixWords: int(o['maxPrefixWords'], 0, 6, d.maxPrefixWords),
    maxPrefixChars: int(o['maxPrefixChars'], 0, 80, d.maxPrefixChars),
    followUpSeconds: int(o['followUpSeconds'], 0, 3600, d.followUpSeconds),
    confidenceThreshold: num(o['confidenceThreshold'], 0, 1, d.confidenceThreshold),
    affirmations:
      'affirmations' in o
        ? parseList(o['affirmations'], { max: 60, maxLen: 40 })
        : [...d.affirmations],
    declines: 'declines' in o ? parseList(o['declines'], { max: 60, maxLen: 40 }) : [...d.declines],
    replyLimitPerMember: int(o['replyLimitPerMember'], 1, 120, d.replyLimitPerMember),
    replyLimitPerChat: int(o['replyLimitPerChat'], 1, 600, d.replyLimitPerChat),
    undoWindowSeconds: int(o['undoWindowSeconds'], 0, 86400, d.undoWindowSeconds),
    defaultLanguage: persona[defaultLanguage] ? defaultLanguage : d.defaultLanguage,
    nicknames: {
      enabled: bool(nick['enabled'], d.nicknames.enabled),
      words:
        'words' in nick
          ? parseList(nick['words'], { max: 40, maxLen: 40 })
          : [...d.nicknames.words],
      spamLimit: int(nick['spamLimit'], 1, 20, d.nicknames.spamLimit),
    },
    persona,
    retorts,
  };
}

/** Fills `{placeholders}` in a persona string. Unknown placeholders stay put. */
export function fillPersona(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const INTERACTION_KEY = 'interaction';

/**
 * In-process cache of the interaction settings, refreshed on write — the bot
 * reads these on every incoming message, so it must never hit the DB per message.
 */
export class InteractionService {
  private constructor(
    private readonly db: Queryable,
    private current: InteractionSettings,
  ) {}

  static async load(db: Queryable): Promise<InteractionService> {
    const stored = await getSetting(db, INTERACTION_KEY);
    return new InteractionService(db, normalizeInteraction(stored ?? {}));
  }

  /** All-defaults service for harnesses and for buildServer's fallback path. */
  static withDefaults(db: Queryable): InteractionService {
    return new InteractionService(db, normalizeInteraction({}));
  }

  get(): InteractionSettings {
    return this.current;
  }

  async save(next: unknown, actor: string): Promise<InteractionSettings> {
    const normalized = normalizeInteraction(next);
    await setSetting(this.db, INTERACTION_KEY, normalized);
    await writeAudit(this.db, actor, 'interaction.update', 'interaction', normalized);
    this.current = normalized;
    return normalized;
  }
}
