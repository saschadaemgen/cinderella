/**
 * The deterministic rule-based intent resolver (CCB-S3-002 §3).
 *
 * No AI. Per-intent keyword and phrase sets in English AND German — the wake
 * word is language-agnostic, so the instruction after it can be in either — are
 * matched against the normalised instruction with typo tolerance, scored, and
 * guarded.
 *
 * Three properties are worth stating, because they are what keep this honest:
 *
 *  - **Phrases outrank keywords.** `stop publishing` must not be read as
 *    `publish` with a stray word in front of it, so a longer contiguous match
 *    always scores above a single keyword.
 *  - **Doubt is expressed as UNKNOWN, not as a guess.** A negation next to the
 *    keyword, a hypothetical framing (`what happens if I say ...`), or a keyword
 *    inside quotation marks collapses the score. Asking again is cheap;
 *    publishing someone who did not ask is not.
 *  - **Nothing here executes anything.** The result is a report. The engine
 *    decides what to do with it, and the consent code decides whether that is
 *    allowed.
 */

import {
  unknownResult,
  type Intent,
  type IntentContext,
  type IntentResolver,
  type IntentResult,
  type IntentSlots,
} from './intent.js';
import {
  fuzzyEquals,
  detectLanguageFromTokens,
  isQuoted,
  normTokens,
  quotedRanges,
  tokenize,
  type Token,
} from './text.js';
import { parseAmountAt, unitMultiplier } from '../price/amount.js';

/* ── Lexicon ─────────────────────────────────────────────────────────────── */

interface LexEntry {
  intent: Exclude<Intent, 'UNKNOWN'>;
  lang: string;
  /** Multi-word forms. Score higher than keywords, longest first. */
  phrases: string[];
  /** Single words. */
  keywords: string[];
}

const LEXICON: LexEntry[] = [
  {
    intent: 'PUBLISH',
    lang: 'en',
    phrases: [
      'publish me',
      'publish my messages',
      'publish my stuff',
      'publish my words',
      'publish my posts',
      'publish everything',
      'opt me in',
      'opt in',
      'sign me up',
      'count me in',
      'make me public',
      'go public',
      'put me in the archive',
      'add me to the archive',
      'you can publish',
      'you may publish',
      'i want to be published',
      'i want to publish',
    ],
    keywords: ['publish', 'publishing', 'publicise', 'publicize'],
  },
  {
    intent: 'PUBLISH',
    lang: 'de',
    phrases: [
      'veröffentliche mich',
      'veröffentliche meine nachrichten',
      'veröffentliche meine sachen',
      'veröffentliche alles',
      'nimm mich auf',
      'melde mich an',
      'ich möchte veröffentlichen',
      'ich will veröffentlichen',
      'du darfst veröffentlichen',
      'mach mich öffentlich',
      'gib mich frei',
    ],
    keywords: ['veröffentlichen', 'veröffentliche', 'veröffentlicht', 'freigeben', 'freigabe'],
  },
  {
    intent: 'UNPUBLISH',
    lang: 'en',
    phrases: [
      'unpublish me',
      'opt me out',
      'opt out',
      'take it back',
      'take me out',
      'take me off',
      'take my words back',
      'remove me',
      'remove me from the archive',
      'delete me from the archive',
      'hide me',
      'stop publishing',
      'stop publishing me',
      'withdraw my consent',
      'withdraw me',
      'i want out',
      'get me out',
      'no longer public',
    ],
    keywords: ['unpublish', 'unpublishing', 'withdraw', 'retract'],
  },
  {
    intent: 'UNPUBLISH',
    lang: 'de',
    phrases: [
      'widerrufe meine zustimmung',
      'widerruf meine zustimmung',
      'nimm mich raus',
      'nimm mich heraus',
      'melde mich ab',
      'lösche mich aus dem archiv',
      'entferne mich aus dem archiv',
      'verberge mich',
      'nimm es zurück',
      'nimm alles zurück',
      'hör auf zu veröffentlichen',
      'ich will raus',
      'mach mich unsichtbar',
    ],
    keywords: [
      'widerrufen',
      'widerrufe',
      'widerruf',
      'abmelden',
      'zurückziehen',
      'zurücknehmen',
      'verbergen',
    ],
  },
  {
    intent: 'STATUS',
    lang: 'en',
    phrases: [
      'what do you have on me',
      'what do you have of mine',
      'what do you keep of mine',
      'what have you got on me',
      'what do you know about me',
      'am i opted in',
      'am i published',
      'am i public',
      'what is my status',
      'how many messages do you have',
      'do you have anything on me',
      'show me my status',
    ],
    keywords: ['status'],
  },
  {
    intent: 'STATUS',
    lang: 'de',
    phrases: [
      'was hast du über mich',
      'was hast du von mir',
      'was bewahrst du von mir',
      'was weißt du über mich',
      'bin ich angemeldet',
      'bin ich veröffentlicht',
      'bin ich öffentlich',
      'wie ist mein status',
      'wie viele nachrichten hast du',
    ],
    keywords: ['status'],
  },
  {
    intent: 'SEARCH',
    lang: 'en',
    phrases: [
      'search the archive for',
      'look through the archive for',
      'search for',
      'look for',
      'search the archive',
    ],
    keywords: ['search', 'find'],
  },
  {
    intent: 'SEARCH',
    lang: 'de',
    phrases: ['durchsuche das archiv nach', 'suche im archiv nach', 'suche nach', 'such nach'],
    keywords: ['suche', 'suchen', 'finde', 'finden', 'durchsuche'],
  },
  {
    intent: 'HELP',
    lang: 'en',
    phrases: [
      'what can you do',
      'how do i use you',
      'what are your commands',
      'how does this work',
      'what are you for',
    ],
    keywords: ['help', 'commands'],
  },
  {
    intent: 'HELP',
    lang: 'de',
    phrases: [
      'was kannst du',
      'wie funktioniert das',
      'welche befehle',
      'wie benutze ich dich',
      'wofür bist du da',
    ],
    keywords: ['hilfe', 'befehle'],
  },
  {
    intent: 'PRICE',
    lang: 'en',
    phrases: [
      'what is the price of',
      'what is the current value of',
      'what is the value of',
      'what is the dollar value of',
      'how much',
      'how many',
      'how much is',
      'how much are',
      'how much do i get for',
      'how much would i get for',
      'price of',
      'value of',
      'worth in',
      'is worth',
      'are worth',
      'convert',
      'exchange rate',
      'rate of',
    ],
    keywords: ['price', 'worth', 'value', 'rate', 'quote'],
  },
  {
    intent: 'PRICE',
    lang: 'de',
    phrases: [
      'was ist ein',
      'was kostet',
      'was kosten',
      'wie viel',
      'wie viele',
      'wie viel ist',
      'wie viel sind',
      'wie viel bekomme ich fuer',
      'wie viel kriege ich fuer',
      'kurs von',
      'preis von',
      'wert von',
      'in euro wert',
      'wert in',
      'umrechnen',
      'wechselkurs',
    ],
    keywords: ['kurs', 'preis', 'wert', 'wechselkurs'],
  },
  {
    intent: 'UNDO',
    lang: 'en',
    phrases: ['undo that', 'undo it', 'revert that', 'undo the last'],
    keywords: ['undo', 'revert'],
  },
  {
    intent: 'UNDO',
    lang: 'de',
    phrases: ['mach das rückgängig', 'mach es rückgängig'],
    keywords: ['rückgängig', 'undo'],
  },
];

interface Pattern {
  intent: Exclude<Intent, 'UNKNOWN'>;
  lang: string;
  tokens: string[];
  phrase: boolean;
}

const PATTERNS: Pattern[] = LEXICON.flatMap((e) => [
  ...e.phrases.map((p) => ({
    intent: e.intent,
    lang: e.lang,
    tokens: normTokens(p),
    phrase: true,
  })),
  ...e.keywords.map((k) => ({
    intent: e.intent,
    lang: e.lang,
    tokens: normTokens(k),
    phrase: false,
  })),
]).filter((p) => p.tokens.length > 0);

/* ── Guards ──────────────────────────────────────────────────────────────── */

/**
 * Framings that make a keyword a description rather than an instruction. These
 * are checked over the WHOLE instruction, not just near the keyword — a member
 * asking `what happens if I say Cinderella publish me` is discussing the bot,
 * not commanding it.
 */
const HYPOTHETICALS = [
  'what happens if',
  'what would happen if',
  'what if',
  'if i say',
  'if i said',
  'if someone says',
  'for example',
  'imagine',
  'hypothetically',
  'just kidding',
  'was passiert wenn',
  'was würde passieren wenn',
  'wenn ich sage',
  'wenn jemand sagt',
  'zum beispiel',
  'stell dir vor',
  'angenommen',
  'nur ein scherz',
].map((h) => normTokens(h));

/** Negations. Applied only OUTSIDE the matched span — see {@link negatedNear}. */
const NEGATIONS = new Set([
  'not',
  'dont',
  'doesnt',
  'didnt',
  'wont',
  'cant',
  'cannot',
  'never',
  'no',
  'nor',
  'neither',
  'without',
  'nicht',
  'nie',
  'niemals',
  'kein',
  'keine',
  'keinen',
  'keinem',
  'nein',
  'ohne',
  'weder',
]);

/** How many tokens either side of the match a negation still poisons. */
const NEGATION_RADIUS = 3;

/**
 * Third-person targets. Deliberately conservative: German `sie`, `er`, `alle`
 * and bare `sein` are NOT here, because they collide with ordinary phrasing
 * (`alle meine Nachrichten` = all MY messages) and a false refusal is a bad
 * enough experience to be worth avoiding.
 */
const THIRD_PARTY_PRONOUNS = new Set([
  'him',
  'his',
  'her',
  'hers',
  'he',
  'she',
  'they',
  'them',
  'their',
  'theirs',
  'us',
  'we',
  'our',
  'ours',
  'everyone',
  'everybody',
  'someone',
  'somebody',
  'ihn',
  'ihm',
  'ihre',
  'ihren',
  'ihrem',
  'ihrer',
  'seine',
  'seinen',
  'seinem',
  'seiner',
  'uns',
  'unsere',
  'unseren',
  'jemand',
  'jemanden',
]);

const FIRST_PERSON = new Set([
  'i',
  'me',
  'my',
  'mine',
  'myself',
  'ich',
  'mich',
  'mir',
  'mein',
  'meine',
  'meinen',
  'meinem',
  'meiner',
  'meins',
]);

/**
 * Ordinary words that happen to be capitalised — every German noun, for a start.
 * A capitalised token in here is never mistaken for somebody's name.
 */
const COMMON_WORDS = new Set(
  [
    // English function words and the nouns these instructions actually use
    'a',
    'an',
    'the',
    'you',
    'your',
    'yours',
    'please',
    'can',
    'could',
    'would',
    'will',
    'shall',
    'do',
    'does',
    'did',
    'to',
    'for',
    'of',
    'on',
    'in',
    'from',
    'with',
    'and',
    'or',
    'but',
    'it',
    'its',
    'that',
    'this',
    'these',
    'those',
    'all',
    'everything',
    'anything',
    'something',
    'thing',
    'things',
    'stuff',
    'message',
    'messages',
    'word',
    'words',
    'post',
    'posts',
    'text',
    'texts',
    'data',
    'archive',
    'public',
    'private',
    'now',
    'again',
    'ok',
    'okay',
    'thanks',
    'thank',
    'yes',
    'no',
    'photo',
    'photos',
    'picture',
    'pictures',
    'image',
    'images',
    'video',
    'videos',
    'link',
    'links',
    'file',
    'files',
    'media',
    'chat',
    'group',
    'here',
    'there',
    'what',
    'when',
    'where',
    'how',
    'why',
    'who',
    'am',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'have',
    'has',
    'had',
    'want',
    'like',
    'need',
    'about',
    'up',
    'out',
    'off',
    'back',
    'last',
    'next',
    // German
    'ein',
    'eine',
    'einen',
    'einem',
    'einer',
    'der',
    'die',
    'das',
    'den',
    'dem',
    'des',
    'du',
    'dich',
    'dir',
    'dein',
    'deine',
    'bitte',
    'kann',
    'kannst',
    'könnte',
    'würde',
    'wirst',
    'mach',
    'machen',
    'macht',
    'tu',
    'tun',
    'zu',
    'für',
    'von',
    'auf',
    'aus',
    'mit',
    'und',
    'oder',
    'aber',
    'es',
    'dies',
    'diese',
    'alles',
    'alle',
    'sachen',
    'kram',
    'zeug',
    'nachricht',
    'nachrichten',
    'wort',
    'worte',
    'wörter',
    'beitrag',
    'beiträge',
    'daten',
    'archiv',
    'öffentlich',
    'jetzt',
    'nochmal',
    'danke',
    'bild',
    'bilder',
    'foto',
    'fotos',
    'video',
    'videos',
    'medien',
    'datei',
    'dateien',
    'text',
    'texte',
    'ding',
    'dinge',
    'eintrag',
    'einträge',
    'kommentar',
    'kommentare',
    'gruppe',
    'chat',
    'hier',
    'dort',
    'was',
    'wann',
    'wo',
    'wie',
    'warum',
    'wer',
    'bin',
    'ist',
    'sind',
    'war',
    'sein',
    'habe',
    'hast',
    'hat',
    'haben',
    'möchte',
    'will',
    'brauche',
    'über',
    'raus',
    'rein',
    'zurück',
    'letzte',
    'letzten',
    'nächste',
    'ja',
    'nein',
  ].flatMap((w) => normTokens(w)),
);

/** Every word the lexicon itself knows — those are instructions, not names. */
const LEXICON_WORDS = new Set(PATTERNS.flatMap((p) => p.tokens));

function isKnownWord(norm: string): boolean {
  return (
    LEXICON_WORDS.has(norm) ||
    COMMON_WORDS.has(norm) ||
    FIRST_PERSON.has(norm) ||
    THIRD_PARTY_PRONOUNS.has(norm) ||
    NEGATIONS.has(norm)
  );
}

/* ── Matching ────────────────────────────────────────────────────────────── */

interface Match {
  /** Index of the first instruction token covered. */
  start: number;
  /** Index one past the last instruction token covered. */
  end: number;
  /** True when at least one token needed typo tolerance to line up. */
  fuzzy: boolean;
}

/** Finds `pat` as a contiguous run in `instr`, preferring an exact alignment. */
function findWindow(instr: string[], pat: string[]): Match | null {
  const n = pat.length;
  if (n === 0 || instr.length < n) return null;
  let fuzzyHit: Match | null = null;

  for (let i = 0; i + n <= instr.length; i++) {
    let ok = true;
    let fuzzy = false;
    for (let j = 0; j < n; j++) {
      const a = instr[i + j] as string;
      const b = pat[j] as string;
      if (a === b) continue;
      if (fuzzyEquals(a, b)) {
        fuzzy = true;
        continue;
      }
      ok = false;
      break;
    }
    if (!ok) continue;
    const m: Match = { start: i, end: i + n, fuzzy };
    if (!fuzzy) return m;
    fuzzyHit ??= m;
  }
  return fuzzyHit;
}

/**
 * Score for a match. A multi-word phrase always beats a single keyword, and an
 * exact hit always beats a typo-tolerant one, so `stop publishing` (phrase)
 * cannot be overruled by `publish` (keyword) sitting inside it.
 */
function scoreOf(pattern: Pattern, m: Match): number {
  const len = pattern.tokens.length;
  if (pattern.phrase) {
    const base = m.fuzzy ? 0.8 : 0.9;
    return Math.min(1, base + 0.02 * len);
  }
  return m.fuzzy ? 0.6 : 0.75;
}

/** Does the whole instruction contain a hypothetical framing? */
function isHypothetical(instr: string[]): boolean {
  return HYPOTHETICALS.some((h) => findWindow(instr, h) !== null);
}

/**
 * A negation close to (but not inside) the match. Negations that are PART of the
 * matched phrase are intentional — `no longer public` means what it says.
 */
function negatedNear(instr: string[], m: Match): boolean {
  const from = Math.max(0, m.start - NEGATION_RADIUS);
  const to = Math.min(instr.length, m.end + NEGATION_RADIUS);
  for (let i = from; i < to; i++) {
    if (i >= m.start && i < m.end) continue;
    if (NEGATIONS.has(instr[i] as string)) return true;
  }
  return false;
}

/* ── Slots ───────────────────────────────────────────────────────────────── */

/**
 * Detects that the instruction is about SOMEBODY ELSE (§4.2). Three signals,
 * in increasing order of guesswork:
 *
 *  1. an explicit third-person pronoun — always decisive;
 *  2. an `@mention`, or a capitalised possessive (`Max's`) — always decisive;
 *  3. an unknown capitalised word, but ONLY when the instruction contains no
 *     first-person marker at all. `veröffentliche meine Fotos` says `meine`, so
 *     `Fotos` is not read as a person; `publish Max` says nothing about the
 *     speaker, so `Max` is.
 */
function findTargetName(text: string, tokens: Token[]): string | undefined {
  const hasFirstPerson = tokens.some((t) => FIRST_PERSON.has(t.norm));

  for (const t of tokens) {
    if (THIRD_PARTY_PRONOUNS.has(t.norm)) return t.raw;
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    const capitalised = t.raw[0] !== undefined && t.raw[0] !== t.raw[0].toLowerCase();
    if (!capitalised || t.norm.length < 2) continue;

    const mentioned = t.start > 0 && text[t.start - 1] === '@';
    const possessive = /['’ʼ]s$/.test(t.raw);
    if (mentioned || possessive) {
      if (!isKnownWord(t.norm.replace(/s$/, '')) && !isKnownWord(t.norm)) return t.raw;
      continue;
    }
    if (hasFirstPerson || i === 0) continue;
    if (!isKnownWord(t.norm)) return t.raw;
  }
  return undefined;
}

/** Everything after the search keyword, minus a leading `for` / `nach`. */
function extractQuery(text: string, tokens: Token[], m: Match): string | undefined {
  const rest = tokens.slice(m.end);
  const first = rest[0];
  if (!first) return undefined;
  const skip = first.norm === 'for' || first.norm === 'nach' || first.norm === 'about' ? 1 : 0;
  const from = rest[skip];
  if (!from) return undefined;
  const q = text
    .slice(from.start)
    .replace(/["“”„«»]/g, '')
    .trim();
  return q || undefined;
}

/* ── Price slots (CCB-S3-004 §1) ─────────────────────────────────────────── */

/**
 * Words that are grammar rather than assets, so the symbol scan can skip them.
 * Deliberately NOT a list of assets: which symbols exist is the registry's
 * business, and the resolver must not need updating when an operator adds a
 * token.
 */
const PRICE_STOPWORDS = new Set([
  'what',
  'whats',
  'is',
  'are',
  'the',
  'a',
  'an',
  'of',
  'in',
  'to',
  'for',
  'do',
  'does',
  'i',
  'me',
  'my',
  'you',
  'get',
  'much',
  'many',
  'how',
  'much',
  'current',
  'currently',
  'now',
  'right',
  'about',
  'worth',
  'value',
  'price',
  'rate',
  'quote',
  'convert',
  'at',
  'moment',
  'today',
  'please',
  'tell',
  'give',
  'would',
  'will',
  'and',
  'one',
  'exchange',
  'was',
  'ist',
  'ein',
  'eine',
  'der',
  'die',
  'das',
  'wie',
  'viel',
  'viele',
  'von',
  'im',
  'kurs',
  'preis',
  'wert',
  'kostet',
  'kosten',
  'bekomme',
  'kriege',
  'ich',
  'fuer',
  'mir',
  'gerade',
  'aktuell',
  'aktuelle',
  'aktueller',
  'jetzt',
  'bitte',
  'sag',
  'sage',
  'und',
  'umrechnen',
  'wechselkurs',
  'us',
  'usd',
]);

/** Tokens that introduce the QUOTE currency. */
const QUOTE_MARKERS = new Set(['in', 'to', 'into', 'gegen', 'nach']);
/** Tokens that introduce the BASE asset: "the value OF hex". */
const BASE_MARKERS = new Set(['of', 'von']);
/** "the <currency> VALUE of x" — the word before these names the quote. */
const VALUE_WORDS = new Set(['value', 'price', 'worth', 'wert', 'preis', 'kurs']);
/** Tokens that introduce the amount+base in a "how much X for N Y" question. */
const FOR_MARKERS = new Set(['for', 'fuer', 'per']);

interface PriceSlots {
  base?: string;
  quote?: string;
  amount?: number;
}

/**
 * Pulls the asset words and the amount out of a price question.
 *
 * The resolver deliberately extracts CANDIDATE WORDS, not assets: it hands
 * `base`/`quote` back as the member wrote them and the price service resolves
 * them against the admin-editable registry. That keeps "which symbols exist"
 * out of the resolver entirely, which is what lets an operator add a token
 * without a code change — and it is the same separation that keeps the resolver
 * free of anything it could execute.
 *
 * Two shapes matter most:
 *   `price of HEX in EUR`                     → base HEX, quote EUR
 *   `how much Ethereum do I get for 1m HEX`   → quote Ethereum, base HEX (reversed)
 */
function extractPriceSlots(tokens: Token[]): PriceSlots {
  const norms = tokens.map((t) => t.norm);
  const slots: PriceSlots = {};

  // The amount, and where it sits.
  let amountAt = -1;
  let amountLen = 0;
  for (let i = 0; i < norms.length; i++) {
    const parsed = parseAmountAt(norms, i);
    if (parsed) {
      slots.amount = parsed.value;
      amountAt = i;
      amountLen = parsed.tokens;
      break;
    }
  }

  const isCandidate = (i: number): boolean => {
    const n = norms[i];
    if (!n) return false;
    if (PRICE_STOPWORDS.has(n)) return false;
    if (unitMultiplier(n) !== undefined) return false;
    if (parseAmountAt(norms, i)) return false;
    return true;
  };
  const nextCandidate = (from: number, stop = norms.length): string | undefined => {
    for (let i = from; i < stop; i++) if (isCandidate(i)) return tokens[i]?.raw;
    return undefined;
  };

  // Explicit "in <currency>" wins for the quote.
  for (let i = 0; i < norms.length; i++) {
    if (QUOTE_MARKERS.has(norms[i] as string)) {
      const q = nextCandidate(i + 1);
      if (q) {
        slots.quote = q;
        break;
      }
    }
  }

  // "the US dollar VALUE of HEX" — the word immediately before "value" names the
  // currency they want it in. Only the immediately preceding token counts: in
  // "the value of HEX" that token is "the", and inventing a quote there would
  // silently answer a different question than the one asked.
  if (!slots.quote) {
    for (let i = 1; i < norms.length; i++) {
      if (!VALUE_WORDS.has(norms[i] as string)) continue;
      // Only the "<currency> value OF <asset>" shape. Without the trailing
      // marker, "what is WAGMI worth" would read WAGMI as the currency and be
      // left with no asset at all.
      const hasBaseMarker = norms.slice(i + 1).some((n) => BASE_MARKERS.has(n));
      if (!hasBaseMarker) continue;
      const before = tokens[i - 1]?.raw;
      if (before && isCandidate(i - 1)) {
        slots.quote = before;
        break;
      }
    }
  }

  // "how much X ... for N Y" — the asset named FIRST is what they want to
  // receive, so it is the quote, and the one after the amount is the base.
  const forAt = norms.findIndex((n) => FOR_MARKERS.has(n));
  if (amountAt >= 0 && forAt >= 0 && forAt < amountAt) {
    const wanted = nextCandidate(0, forAt);
    if (wanted && !slots.quote) slots.quote = wanted;
    const paid = nextCandidate(amountAt + amountLen);
    if (paid) slots.base = paid;
  }

  // "the value OF hex" — an explicit marker beats positional guessing.
  if (!slots.base) {
    for (let i = 0; i < norms.length; i++) {
      if (!BASE_MARKERS.has(norms[i] as string)) continue;
      const b = nextCandidate(i + 1);
      if (b && b !== slots.quote) {
        slots.base = b;
        break;
      }
    }
  }

  if (!slots.base && amountAt >= 0) {
    const afterAmount = nextCandidate(amountAt + amountLen);
    if (afterAmount) slots.base = afterAmount;
  }
  if (!slots.base) {
    // First candidate that is not already claimed as the quote.
    for (let i = 0; i < norms.length; i++) {
      if (!isCandidate(i)) continue;
      const raw = tokens[i]?.raw;
      if (raw && raw !== slots.quote) {
        slots.base = raw;
        break;
      }
    }
  }
  return slots;
}

/* ── The resolver ────────────────────────────────────────────────────────── */

function resolveRules(text: string, ctx: IntentContext): IntentResult {
  const tokens = tokenize(text);
  const instr = tokens.map((t) => t.norm);
  const fallbackLang = detectLanguageFromTokens(instr, ctx.defaultLanguage).lang;

  if (instr.length === 0) return unknownResult(fallbackLang);

  // A hypothetical framing disqualifies the whole message (§3).
  if (isHypothetical(instr)) return unknownResult(fallbackLang);

  const quoted = quotedRanges(text);

  let best: { pattern: Pattern; match: Match; score: number } | null = null;
  for (const pattern of PATTERNS) {
    const match = findWindow(instr, pattern.tokens);
    if (!match) continue;

    let score = scoreOf(pattern, match);

    // A keyword the member is QUOTING is not an instruction.
    const startTok = tokens[match.start];
    const endTok = tokens[match.end - 1];
    if (startTok && endTok && isQuoted(quoted, startTok.start, endTok.end)) score *= 0.2;

    // A negation beside the keyword: better to ask than to act.
    if (negatedNear(instr, match)) score *= 0.3;

    if (
      !best ||
      score > best.score ||
      (score === best.score && pattern.tokens.length > best.pattern.tokens.length)
    ) {
      best = { pattern, match, score };
    }
  }

  if (!best || best.score < ctx.threshold) {
    return unknownResult(best?.pattern.lang ?? fallbackLang);
  }

  const { pattern, match, score } = best;
  const slots: IntentSlots = {};

  if (pattern.intent === 'SEARCH') {
    const query = extractQuery(text, tokens, match);
    if (query !== undefined) slots.query = query;
  }

  if (pattern.intent === 'PRICE') {
    const price = extractPriceSlots(tokens);
    if (price.base !== undefined) slots.base = price.base;
    if (price.quote !== undefined) slots.quote = price.quote;
    if (price.amount !== undefined) slots.amount = price.amount;
  }

  // Third-party targeting only matters where consent is at stake.
  if (pattern.intent === 'PUBLISH' || pattern.intent === 'UNPUBLISH') {
    const target = findTargetName(text, tokens);
    if (target !== undefined) slots.targetName = target;
  }

  return { intent: pattern.intent, confidence: score, slots, lang: pattern.lang };
}

/** The rule engine as an {@link IntentResolver}. Registered by default. */
export const ruleResolver: IntentResolver = {
  name: 'rules',
  resolve(text: string, ctx: IntentContext): Promise<IntentResult> {
    return Promise.resolve(resolveRules(text, ctx));
  },
};
