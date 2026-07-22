/**
 * Amount parsing for price questions (CCB-S3-004 §1).
 *
 * Members write numbers the way people write numbers: `1 million`, `1m`,
 * `1.5k`, `100k`, `1,000,000`, and — in German — `1.000.000` and `1,5`. The
 * separators mean opposite things in the two conventions, so the shape of the
 * number decides, not a locale setting we do not have.
 *
 * German "Billion" is deliberately NOT supported: it means 10^12, while English
 * "billion" means 10^9, and silently picking one would be a factor-of-1000 error
 * in a message about money. `Milliarde` is unambiguous and is supported.
 */

/** Multipliers, keyed by the normalised unit word. */
const UNITS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  thousands: 1e3,
  tausend: 1e3,
  m: 1e6,
  mio: 1e6,
  million: 1e6,
  millions: 1e6,
  millionen: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  billions: 1e9,
  milliarde: 1e9,
  milliarden: 1e9,
};

/** Beyond this we treat the input as nonsense rather than answer it. */
const MAX_AMOUNT = 1e15;

export function unitMultiplier(word: string): number | undefined {
  return UNITS[word.toLowerCase()];
}

/**
 * Parses a bare numeric string, working out what the separators mean from the
 * shape of the number rather than assuming a locale.
 *
 *   `1,000,000` → 1000000   (grouped)
 *   `1.000.000` → 1000000   (grouped, German)
 *   `1,5`       → 1.5       (German decimal)
 *   `1.5`       → 1.5       (English decimal)
 *   `1.234,56`  → 1234.56   (German mixed)
 *   `1,234.56`  → 1234.56   (English mixed)
 */
export function parseNumber(raw: string): number | undefined {
  const s = raw.trim().replace(/\s+/g, '');
  if (!s || !/^[\d.,]+$/.test(s)) return undefined;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalised: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal separator.
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    normalised = s.split(groupSep).join('').replace(decimalSep, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1] as string;
    // Exactly three trailing digits with more than one group reads as grouping
    // (`1.000`, `1,000,000`); anything else reads as a decimal fraction.
    const grouped =
      parts.length > 1 && tail.length === 3 && parts.slice(1).every((p) => p.length === 3);
    normalised = grouped ? parts.join('') : parts.join('.');
  } else {
    normalised = s;
  }

  const n = Number.parseFloat(normalised);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export interface ParsedAmount {
  value: number;
  /** How many tokens the amount consumed (number, plus a unit word if present). */
  tokens: number;
}

/**
 * Reads an amount starting at `tokens[i]`, absorbing a following unit word.
 * Returns undefined when there is no sensible number there, and also when the
 * result is absurd — a member asking about 10^30 HEX gets a polite miss rather
 * than a number in scientific notation.
 */
export function parseAmountAt(tokens: string[], i: number): ParsedAmount | undefined {
  const first = tokens[i];
  if (first === undefined) return undefined;

  // `1m` / `1.5k` written as one token.
  const glued = /^([\d.,]+)([a-z]+)$/i.exec(first);
  if (glued) {
    const n = parseNumber(glued[1] as string);
    const mult = unitMultiplier(glued[2] as string);
    if (n !== undefined && mult !== undefined) {
      const value = n * mult;
      return value > 0 && value <= MAX_AMOUNT ? { value, tokens: 1 } : undefined;
    }
  }

  const n = parseNumber(first);
  if (n === undefined) return undefined;

  const next = tokens[i + 1];
  const mult = next ? unitMultiplier(next) : undefined;
  const value = mult !== undefined ? n * mult : n;
  if (!(value > 0) || value > MAX_AMOUNT) return undefined;
  return { value, tokens: mult !== undefined ? 2 : 1 };
}
