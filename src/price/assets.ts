/**
 * The asset registry (CCB-S3-004 §2) — the fix for ticker collisions.
 *
 * A symbol is not an identity. `HEX` resolves to at least three different assets
 * on the provider used here: the original Ethereum token, the PulseChain copy,
 * and a bridged version — and that is before counting outright scam clones. A
 * price answered from a bare symbol lookup is therefore a coin flip that happens
 * to be right most of the time, which is the worst kind of wrong.
 *
 * So nothing is ever resolved by symbol against the provider. Members type
 * symbols; this registry maps them to a CANONICAL PROVIDER ID that the operator
 * has pinned, and for tokens it records the chain and contract address as the
 * durable evidence of WHICH asset was meant. If a symbol maps to more than one
 * entry, she asks instead of choosing.
 */

export type AssetKind = 'crypto' | 'fiat';

export interface AssetEntry {
  /** What members type. Matched case-insensitively. */
  symbol: string;
  /**
   * The provider's canonical id — `hex`, `ethereum`, `usd`. THIS is what is sent
   * to the provider; the symbol never is.
   */
  id: string;
  /** Display name used in replies. */
  name: string;
  kind: AssetKind;
  /** Maximum decimals to show when a value is expressed in this asset. */
  decimals: number;
  /** Other things members call it (`ether`, `dollar`, `euro`). */
  aliases: string[];
  /** Chain the contract below lives on. Documentation of which asset this is. */
  chain?: string;
  /** Token contract address — the unambiguous identity of a token. */
  contract?: string;
}

/**
 * Shipped registry. HEX is pinned to the original Ethereum token by contract
 * address (verified against the provider), NOT to `hex-pulsechain` or to any
 * bridged variant.
 */
export const DEFAULT_ASSETS: AssetEntry[] = [
  {
    symbol: 'HEX',
    id: 'hex',
    name: 'HEX',
    kind: 'crypto',
    decimals: 8,
    aliases: [],
    chain: 'ethereum',
    contract: '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39',
  },
  {
    symbol: 'BTC',
    id: 'bitcoin',
    name: 'Bitcoin',
    kind: 'crypto',
    decimals: 8,
    aliases: ['bitcoin', 'xbt'],
  },
  {
    symbol: 'ETH',
    id: 'ethereum',
    name: 'Ethereum',
    kind: 'crypto',
    decimals: 8,
    aliases: ['ethereum', 'ether'],
    chain: 'ethereum',
  },
  {
    symbol: 'USD',
    id: 'usd',
    name: 'US Dollar',
    kind: 'fiat',
    decimals: 4,
    aliases: ['usd', 'dollar', 'dollars', 'us dollar', 'us dollars', 'usdollar', '$'],
  },
  {
    symbol: 'EUR',
    id: 'eur',
    name: 'Euro',
    kind: 'fiat',
    decimals: 4,
    aliases: ['eur', 'euro', 'euros', '€'],
  },
];

/** Normalises a symbol or alias for comparison. */
export function normalizeSymbol(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9$€ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AssetLookup {
  /** Exactly one match. */
  asset?: AssetEntry;
  /** More than one registry entry claims this symbol — ask, do not choose. */
  ambiguous?: AssetEntry[];
}

/**
 * Finds the asset a member's word refers to. Returns `ambiguous` when the
 * registry itself is ambiguous, which is the operator's cue to disambiguate the
 * symbols rather than the bot's cue to guess.
 */
export function lookupAsset(registry: AssetEntry[], text: string): AssetLookup {
  const needle = normalizeSymbol(text);
  if (!needle) return {};

  const matches = registry.filter(
    (a) =>
      normalizeSymbol(a.symbol) === needle ||
      a.aliases.some((alias) => normalizeSymbol(alias) === needle),
  );
  if (matches.length === 0) return {};
  if (matches.length > 1) {
    // Same canonical id listed twice is a duplicate, not an ambiguity.
    const distinct = [...new Map(matches.map((m) => [m.id, m])).values()];
    if (distinct.length > 1) return { ambiguous: distinct };
    return { asset: distinct[0] as AssetEntry };
  }
  return { asset: matches[0] as AssetEntry };
}

/**
 * Formats a value for chat. Precision follows the MAGNITUDE, capped by the
 * asset's configured decimals: a fraction of a cent for HEX, two decimals for a
 * Bitcoin price, and never raw floating-point noise.
 */
export function formatValue(value: number, maxDecimals: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  let decimals: number;
  if (abs >= 1000) decimals = 2;
  else if (abs >= 1) decimals = 4;
  else if (abs >= 0.01) decimals = 6;
  else decimals = 8;
  decimals = Math.min(decimals, Math.max(0, maxDecimals));
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/** Formats the amount a member asked about (`1,000,000 HEX`). */
export function formatAmount(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
}
