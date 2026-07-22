/**
 * Price lookups and conversions (CCB-S3-004 §3, §4).
 *
 * Three jobs, in order:
 *
 *  1. **Resolve** the words a member typed to registry entries, never to a bare
 *     provider symbol lookup (see `assets.ts` for why that matters).
 *  2. **Quote**, through a short-TTL cache so the provider is not called per
 *     message. Public price APIs throttle quickly, and a group can easily send
 *     more price questions per minute than the free tier allows.
 *  3. **Convert**, through the common quote currency. `HEX → ETH` has no direct
 *     pair on any venue worth trusting, so it is computed as HEX/USD ÷ ETH/USD.
 *
 * Everything that can fail returns a typed outcome rather than throwing into the
 * dialogue, and no outcome ever carries an invented number.
 */

import { log } from '../log.js';
import { formatAmount, formatValue, lookupAsset, type AssetEntry } from './assets.js';
import type { PriceProvider, Quote } from './provider.js';

export interface PriceServiceOptions {
  provider: PriceProvider;
  registry: () => AssetEntry[];
  /** The currency everything is crossed through and quoted in by default. */
  baseCurrency: () => string;
  cacheTtlMs: () => number;
  now?: () => number;
}

export type PriceOutcome =
  | {
      kind: 'price';
      amount: number;
      base: AssetEntry;
      quote: AssetEntry;
      value: number;
      at: number;
    }
  | {
      kind: 'conversion';
      amount: number;
      base: AssetEntry;
      quote: AssetEntry;
      value: number;
      at: number;
    }
  | { kind: 'unknown-asset'; symbol: string }
  | { kind: 'ambiguous'; symbol: string; options: AssetEntry[] }
  | { kind: 'unavailable' };

interface CacheEntry {
  quote: Quote;
  storedAt: number;
}

export class PriceService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(private readonly opts: PriceServiceOptions) {
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Resolves a member's word to a registry entry, or reports why it cannot. */
  resolve(text: string): { asset?: AssetEntry; ambiguous?: AssetEntry[] } {
    return lookupAsset(this.opts.registry(), text);
  }

  /**
   * Finds the first resolvable asset among several candidate words. Used as the
   * fallback when the resolver's slot extraction did not isolate a clean symbol.
   */
  resolveFirst(candidates: string[]): { asset?: AssetEntry; ambiguous?: AssetEntry[] } {
    for (const c of candidates) {
      const r = this.resolve(c);
      if (r.asset || r.ambiguous) return r;
    }
    return {};
  }

  private cacheKey(id: string, vs: string): string {
    return `${id}|${vs}`;
  }

  /** A cached quote if it is still inside the TTL. */
  private cached(id: string, vs: string): Quote | undefined {
    const entry = this.cache.get(this.cacheKey(id, vs));
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.opts.cacheTtlMs()) return undefined;
    return entry.quote;
  }

  /**
   * Quotes several assets in one currency, hitting the provider only for the
   * ids that are not already cached and fresh.
   */
  private async quotes(ids: string[], vs: string): Promise<Map<string, Quote> | null> {
    const out = new Map<string, Quote>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = this.cached(id, vs);
      if (hit) out.set(id, hit);
      else missing.push(id);
    }
    if (missing.length === 0) return out;

    try {
      const fetched = await this.opts.provider.fetchPrices(missing, vs);
      const storedAt = this.now();
      for (const q of fetched) {
        this.cache.set(this.cacheKey(q.id, q.vs), { quote: q, storedAt });
        out.set(q.id, q);
      }
    } catch (err) {
      log.warn(
        `Price: provider "${this.opts.provider.name}" failed (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
      return null;
    }

    // A provider that answered but omitted an id is still a failure for that id.
    for (const id of ids) {
      if (!out.has(id)) return null;
    }
    return out;
  }

  /**
   * Answers "what is `amount` of `baseText` worth in `quoteText`".
   *
   * A fiat quote is a direct lookup. An asset-to-asset quote is a CROSS RATE
   * through the configured base currency, because direct pairs mostly do not
   * exist: both legs are priced in USD and divided.
   */
  async price(
    baseText: string,
    quoteText: string | undefined,
    amount: number,
  ): Promise<PriceOutcome> {
    const baseHit = this.resolve(baseText);
    if (baseHit.ambiguous)
      return { kind: 'ambiguous', symbol: baseText, options: baseHit.ambiguous };
    if (!baseHit.asset) return { kind: 'unknown-asset', symbol: baseText };
    const base = baseHit.asset;

    let quote: AssetEntry;
    if (quoteText) {
      const quoteHit = this.resolve(quoteText);
      if (quoteHit.ambiguous)
        return { kind: 'ambiguous', symbol: quoteText, options: quoteHit.ambiguous };
      if (!quoteHit.asset) return { kind: 'unknown-asset', symbol: quoteText };
      quote = quoteHit.asset;
    } else {
      const fallback = this.resolve(this.opts.baseCurrency());
      if (!fallback.asset) return { kind: 'unavailable' };
      quote = fallback.asset;
    }

    // Asking what a thing is worth in itself is not an error, just trivial.
    if (base.id === quote.id) {
      return { kind: 'price', amount, base, quote, value: amount, at: this.now() };
    }

    // Direct: the quote currency is one the provider prices things in.
    if (quote.kind === 'fiat') {
      const got = await this.quotes([base.id], quote.id);
      const q = got?.get(base.id);
      if (!q) return { kind: 'unavailable' };
      return { kind: 'price', amount, base, quote, value: amount * q.price, at: q.at };
    }

    // Cross rate through the common currency (§4).
    const via = this.resolve(this.opts.baseCurrency()).asset;
    if (!via) return { kind: 'unavailable' };
    const got = await this.quotes([base.id, quote.id], via.id);
    const baseQ = got?.get(base.id);
    const quoteQ = got?.get(quote.id);
    if (!baseQ || !quoteQ || quoteQ.price === 0) return { kind: 'unavailable' };
    return {
      kind: 'conversion',
      amount,
      base,
      quote,
      value: (amount * baseQ.price) / quoteQ.price,
      at: Math.min(baseQ.at, quoteQ.at),
    };
  }

  /** Formats an outcome's numbers for the persona strings. */
  static render(outcome: Extract<PriceOutcome, { kind: 'price' | 'conversion' }>): {
    amount: string;
    base: string;
    quote: string;
    value: string;
  } {
    return {
      amount: formatAmount(outcome.amount),
      base: outcome.base.symbol,
      quote: outcome.quote.symbol,
      value: formatValue(outcome.value, outcome.quote.decimals),
    };
  }

  /** For diagnostics and the harness. */
  cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
