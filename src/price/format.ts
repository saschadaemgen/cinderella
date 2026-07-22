/**
 * Number formatting for price replies (CCB-S3-004 §4).
 *
 * Precision follows the MAGNITUDE, capped by the asset's configured decimals: a
 * fraction of a cent for a micro-cap, two decimals for a Bitcoin price, and
 * never raw floating-point noise or scientific notation in a chat message.
 */

/** Formats a value expressed in some asset. */
export function formatValue(value: number, maxDecimals: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  let decimals: number;
  if (abs >= 1000) decimals = 2;
  else if (abs >= 1) decimals = 4;
  else if (abs >= 0.01) decimals = 6;
  else decimals = 8;
  decimals = Math.min(decimals, Math.max(0, maxDecimals));
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/** Formats the amount a member asked about (`1,000,000 HEX`). */
export function formatAmount(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
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
  if (mins < 60) return de ? `vor ${mins} Minute${mins === 1 ? '' : 'n'}` : `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  return de ? `vor ${hours} Stunde${hours === 1 ? '' : 'n'}` : `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
