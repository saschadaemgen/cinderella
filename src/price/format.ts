/**
 * Number formatting for price replies (CCB-S3-004 §4, corrected CCB-S3-006 §2).
 *
 * THE BUG THIS REPLACES: precision was capped by the QUOTE asset's decimals, so
 * a price quoted in USD was rounded to four places and a sub-cent token rendered
 * as `0.0005` — or, with two decimals, as a flat `0`. A price of zero is not a
 * rounding artefact to a reader; it is a claim that the thing is worthless.
 *
 * Magnitude decides now, not a per-asset setting: large values get thousands
 * separators and two decimals, small values get SIGNIFICANT FIGURES so the first
 * meaningful digits always survive. A non-zero value never formats as zero.
 */

/** How many significant digits small values keep. */
const SIGNIFICANT = 4;

/** Absolute floor below which we say "essentially zero" rather than lie. */
const TINY = 1e-15;

/**
 * Formats a value for display.
 *
 * `maxDecimals` is an upper bound for the LARGE-value path only; it deliberately
 * does not clamp the small-value path, because that clamp is what produced the
 * zero.
 */
export function formatValue(value: number, maxDecimals = 8): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs < TINY) return '~0';

  if (abs >= 1000) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.min(2, maxDecimals),
    });
  }
  if (abs >= 1) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.min(4, Math.max(2, maxDecimals)),
    });
  }

  // Below 1: keep SIGNIFICANT meaningful digits, however small the value.
  // 0.00047884 -> 0.0004788 ; 0.000000012 -> 0.000000012
  const exponent = Math.floor(Math.log10(abs));
  const decimals = Math.min(20, Math.max(0, SIGNIFICANT - 1 - exponent));
  const out = value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  // Belt and braces: a non-zero value must never render as zero.
  return /^-?0(\.0*)?$/.test(out) ? value.toExponential(2) : out;
}

/** Formats the amount a member asked about (`1,000,000 HEX`). */
export function formatAmount(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/** Compact market cap / liquidity, for disambiguation lists: `$1.3T`, `$412K`. */
export function formatCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '';
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const n = value / size;
      return `$${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return `$${Math.round(value)}`;
}

/**
 * "a moment ago" / "3 minutes ago" — every price reply states its age, so a
 * cached figure is never mistaken for a live tick.
 */
export function describeAge(at: number, now: number, lang: string): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  const de = lang === 'de';
  if (secs < 45) return de ? 'gerade eben' : 'a moment ago';
  const mins = Math.round(secs / 60);
  if (mins < 60)
    return de
      ? `vor ${mins} Minute${mins === 1 ? '' : 'n'}`
      : `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  return de
    ? `vor ${hours} Stunde${hours === 1 ? '' : 'n'}`
    : `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
