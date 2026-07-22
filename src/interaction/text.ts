/**
 * Text primitives for the interaction layer (CCB-S3-002): normalisation,
 * tokenisation with source offsets, and the fuzzy matcher shared by the
 * addressing model (§1) and the intent resolver (§3).
 *
 * Normalisation is deliberately aggressive so that a member's typing habits do
 * not decide whether Cinderella hears them: case is folded, German umlauts are
 * expanded the way people actually type them without a German keyboard
 * (ä→ae, ö→oe, ü→ue, ß→ss), remaining diacritics are stripped, and punctuation
 * is not part of a token. `veröffentliche` and `veroeffentliche` therefore
 * become the same string, which is what makes one keyword list cover both.
 *
 * Fuzziness is length-tiered: short words must match exactly (a one-character
 * slip in a three-letter word is a different word), longer ones tolerate more.
 */

export interface Token {
  /** The token exactly as the member typed it (casing preserved). */
  raw: string;
  /** Normalised form — lowercase, umlaut-folded, diacritic-free, no apostrophes. */
  norm: string;
  /** Offset of the token's first character in the source text. */
  start: number;
  /** Offset one past the token's last character in the source text. */
  end: number;
}

const GERMAN_FOLD: [RegExp, string][] = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
];

const APOSTROPHES = /['’ʼ]/g;

/**
 * Lowercases, expands German umlauts, then strips any remaining combining marks
 * (é→e). The umlaut expansion runs first on purpose: stripping marks first would
 * turn `ö` into `o`, so `veröffentliche` would no longer meet the way the same
 * word is typed on a non-German keyboard.
 */
export function fold(s: string): string {
  let out = s.toLowerCase();
  for (const [re, rep] of GERMAN_FOLD) out = out.replace(re, rep);
  return out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Normalises a whole phrase to a single space-separated string of tokens. */
export function normalize(s: string): string {
  return tokenize(s)
    .map((t) => t.norm)
    .join(' ');
}

// A token is a run of letters/digits, optionally carrying internal apostrophes
// so `what's` and `Cinderella's` stay ONE token. Keeping the possessive attached
// is what lets the addressing model reject `Cinderella's archive` (§1).
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;

/** Splits text into tokens, preserving each token's raw form and source offsets. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const start = m.index;
    out.push({
      raw,
      norm: fold(raw).replace(APOSTROPHES, ''),
      start,
      end: start + raw.length,
    });
  }
  return out;
}

/** Normalised token strings only — the form the keyword/phrase sets are built in. */
export function normTokens(text: string): string[] {
  return tokenize(text).map((t) => t.norm);
}

/**
 * Levenshtein distance with an early exit: once every cell in a row exceeds
 * `max` the true distance can only grow, so we stop and return `max + 1`.
 */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array<number>(bl + 1);
  let cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(
        (cur[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[bl] as number;
}

/**
 * How many character slips a word of this length may absorb. Short words get no
 * slack at all — `cin` and `bin` are different words, not a typo of each other.
 */
export function maxDistanceFor(len: number): number {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

/** Length-tiered fuzzy equality between two already-normalised tokens. */
export function fuzzyEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const max = maxDistanceFor(Math.max(a.length, b.length));
  if (max === 0) return false;
  if (Math.abs(a.length - b.length) > max) return false;
  return levenshtein(a, b, max) <= max;
}

/**
 * Character ranges of the source text that sit inside quotation marks. Used by
 * the resolver's quotation guard (§3): a keyword someone is *quoting* is not an
 * instruction. Single quotes are deliberately not treated as quotation marks,
 * because they are far more often apostrophes.
 */
const QUOTE_CHARS = new Set(['"', '“', '”', '„', '«', '»']);

export function quotedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (!QUOTE_CHARS.has(text[i] as string)) continue;
    if (open < 0) {
      open = i;
    } else {
      ranges.push([open + 1, i]);
      open = -1;
    }
  }
  return ranges;
}

/** True when [start,end) overlaps any quoted range. */
export function isQuoted(ranges: [number, number][], start: number, end: number): boolean {
  return ranges.some(([qs, qe]) => start < qe && end > qs);
}

/**
 * Reply-language detection (CCB-S3-005).
 *
 * THE BUG THIS REPLACES. The first version asked `tokens.some(t => GERMAN_HINTS.has(t))`
 * — a single German-looking word anywhere flipped the whole message to German. It
 * fired live on a 357-word ENGLISH announcement that happened to contain the word
 * `hallo` once, in its own example of `Hallo Cinderella` working in any language.
 * One token in 357 decided the reply language, and she answered in German.
 *
 * The replacement is a scored contest between two hint sets with a margin
 * requirement, so a lone false friend cannot win. `was` (English past tense /
 * German "what"), `hallo`, `man`, `die`, `war`, `also` and `in` are exactly the
 * words that made the old check wrong, so the German set keeps them only where
 * they carry real signal and the English set is stocked with the words that
 * dominate ordinary English prose.
 *
 * This is a REPLY-LANGUAGE hint, not language identification. Getting it wrong
 * costs a message in the wrong language; it never affects consent.
 */
const GERMAN_HINTS = new Set(
  [
    'ich',
    'mich',
    'mir',
    'mein',
    'meine',
    'meinen',
    'meinem',
    'du',
    'dich',
    'dir',
    'dein',
    'deine',
    'nicht',
    'bitte',
    'hast',
    'kannst',
    'ist',
    'sind',
    'bin',
    'und',
    'oder',
    'aber',
    'das',
    'die',
    'der',
    'den',
    'dem',
    'ein',
    'eine',
    'einen',
    'von',
    'für',
    'über',
    'nach',
    'aus',
    'mit',
    'ja',
    'nein',
    'kann',
    'wer',
    'wann',
    'warum',
    'danke',
    'jetzt',
    'noch',
    'schon',
    'auch',
    'wie',
    'was',
    'wird',
    'werden',
    'haben',
    'sich',
    'nur',
    'sehr',
    'mehr',
    'zurück',
    'veröffentliche',
    'veröffentlichen',
    'widerrufen',
    'nachricht',
    'nachrichten',
    'archiv',
  ].map((w) => fold(w)),
);

/**
 * English function words. Present so detection is a CONTEST rather than a hunt for
 * German: ordinary English prose scores heavily here, which is what stops one
 * stray `hallo` from carrying a whole announcement.
 */
const ENGLISH_HINTS = new Set(
  [
    'the',
    'and',
    'you',
    'your',
    'yours',
    'i',
    'me',
    'my',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'not',
    'what',
    'when',
    'where',
    'who',
    'why',
    'how',
    'this',
    'that',
    'these',
    'those',
    'with',
    'from',
    'for',
    'of',
    'to',
    'in',
    'on',
    'at',
    'it',
    'its',
    'can',
    'will',
    'would',
    'please',
    'thanks',
    'thank',
    'yes',
    'no',
    'now',
    'again',
    'more',
    'about',
    'publish',
    'unpublish',
    'message',
    'messages',
    'archive',
    'want',
    'like',
    'know',
  ].map((w) => fold(w)),
);

export interface LanguageGuess {
  /** The detected language code. */
  lang: string;
  /**
   * Whether the evidence was strong enough to act on. When false the caller
   * should fall back to the member's remembered language or the configured
   * default rather than using `lang`.
   */
  confident: boolean;
}

/** Minimum winning hits, and minimum lead over the loser, to call it confident. */
const MIN_HITS = 2;
const MIN_LEAD = 2;

/**
 * Scores a message's tokens against both hint sets. Returns the winner only when
 * it clears both thresholds — otherwise `confident` is false and the caller
 * decides.
 */
export function detectLanguageFromTokens(tokens: string[], fallback: string): LanguageGuess {
  let de = 0;
  let en = 0;
  for (const t of tokens) {
    if (GERMAN_HINTS.has(t)) de++;
    if (ENGLISH_HINTS.has(t)) en++;
  }
  if (de >= MIN_HITS && de - en >= MIN_LEAD) return { lang: 'de', confident: true };
  if (en >= MIN_HITS && en - de >= MIN_LEAD) return { lang: 'en', confident: true };
  return { lang: fallback, confident: false };
}

/** Reply-language hint for a raw string. */
export function detectLanguage(text: string, fallback: string): LanguageGuess {
  return detectLanguageFromTokens(normTokens(text), fallback);
}

/**
 * Back-compatible convenience used where only a code is needed. Prefer
 * {@link detectLanguage} so the caller can see whether the guess was confident.
 */
export function guessLanguage(text: string, fallback: string): string {
  return detectLanguage(text, fallback).lang;
}
