/**
 * The Crypto Prices service (CCB-S3-004 §1, §4, §5).
 *
 * The operating principle, in one place:
 *
 *  - **Prices are always fetched on request.** Never preloaded, never pre-warmed.
 *    A price is only useful when it is current. The only thing between a question
 *    and the provider is a short TTL cache, which exists to stop a busy group
 *    burning the provider's rate limit, not to make prices last longer.
 *  - **Mappings are resolved lazily and then pinned forever.** The first time a
 *    symbol is asked for it is resolved; from then on the pinned mapping is used
 *    and the provider is never asked "what is HEX" again. Re-resolving each time
 *    would mean the same question could quietly return a different token's price
 *    once search rankings moved.
 *  - **Ambiguity is a question, never a guess.** When more than one asset claims
 *    the ticker, the member is asked, and their answer is pinned globally so
 *    nobody is ever asked again.
 */

import { log } from '../../log.js';
import type { Queryable } from '../../db/pool.js';
import {
  findMapping,
  touchMapping,
  upsertMapping,
  type AssetMapping,
} from '../../db/asset-mappings.js';
import { decryptSecret } from '../secrets.js';
import { formatCompact } from '../../price/format.js';
import {
  CoinGeckoProvider,
  CoinMarketCapProvider,
  DexscreenerProvider,
  type AdapterOptions,
} from './providers/adapters.js';
import { ProviderError, type AssetCandidate, type PriceProvider } from './providers/types.js';
import type { CryptoPricesSettings } from './settings.js';

export interface PriceServiceDeps {
  db: Queryable;
  settings: () => CryptoPricesSettings;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Override the adapter set (harness). */
  providers?: PriceProvider[];
}

export interface QuoteResult {
  price: number;
  vs: string;
  at: number;
  provider: string;
  /** Licence-required credit for the provider that actually answered. */
  attribution: string;
}

export type PriceOutcome =
  | {
      kind: 'price' | 'conversion';
      amount: number;
      base: AssetMapping;
      quote: AssetMapping | FiatAsset;
      value: number;
      at: number;
      provider: string;
      attribution: string;
    }
  | { kind: 'ambiguous'; symbol: string; options: AssetCandidate[]; provider: string }
  | { kind: 'unknown-asset'; symbol: string }
  | { kind: 'unavailable' };

/** Fiat currencies are not resolved at a provider; they are the quote side. */
export interface FiatAsset {
  symbol: string;
  displayName: string;
  decimals: number;
  kind: 'fiat';
}

const FIATS: Record<string, FiatAsset> = {
  USD: { symbol: 'USD', displayName: 'US Dollar', decimals: 4, kind: 'fiat' },
  EUR: { symbol: 'EUR', displayName: 'Euro', decimals: 4, kind: 'fiat' },
  GBP: { symbol: 'GBP', displayName: 'British Pound', decimals: 4, kind: 'fiat' },
};

/** Common ways members name a currency, mapped to its code. */
const FIAT_ALIASES: Record<string, string> = {
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  'us dollar': 'USD',
  'us dollars': 'USD',
  $: 'USD',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  '€': 'EUR',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  '£': 'GBP',
};

export function asFiat(text: string): FiatAsset | undefined {
  const k = text.trim().toLowerCase();
  const code = FIAT_ALIASES[k] ?? (k.toUpperCase() in FIATS ? k.toUpperCase() : undefined);
  return code ? FIATS[code] : undefined;
}

interface CacheEntry {
  quote: QuoteResult;
  storedAt: number;
}

/**
 * The figure a candidate is ranked by (§4): market capitalisation where the
 * provider offers it, pool liquidity for DEX results, and otherwise an inverse
 * of the popularity rank. Market-cap rank is null for exactly the micro caps
 * that need separating, so it is the last resort, not the first.
 */
function weightOf(c: AssetCandidate | undefined): number {
  if (!c) return 0;
  if (c.marketCap !== undefined && c.marketCap > 0) return c.marketCap;
  if (c.liquidity !== undefined && c.liquidity > 0) return c.liquidity;
  if (c.volume24h !== undefined && c.volume24h > 0) return c.volume24h;
  if (c.rank !== undefined && c.rank > 0) return 1 / c.rank;
  return 0;
}

/** Human figure shown beside a candidate, so the member can tell them apart. */
export function candidateMetric(c: AssetCandidate): string {
  if (c.marketCap !== undefined && c.marketCap > 0) return formatCompact(c.marketCap);
  if (c.liquidity !== undefined && c.liquidity > 0) return `${formatCompact(c.liquidity)} liq`;
  if (c.rank !== undefined && c.rank > 0) return `#${c.rank}`;
  return '';
}

export class CryptoPriceService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly adapters: PriceProvider[];
  /** Per-provider call timestamps, for the per-provider rate limit. */
  private readonly calls = new Map<string, number[]>();
  /** Last error per provider, surfaced as health in the console. */
  readonly health = new Map<string, { ok: boolean; at: number; detail: string }>();

  constructor(private readonly deps: PriceServiceDeps) {
    this.now = deps.now ?? ((): number => Date.now());
    this.adapters = deps.providers ?? this.buildAdapters();
  }

  private buildAdapters(): PriceProvider[] {
    const opts = (name: string): AdapterOptions => ({
      enabled: () => this.deps.settings().providers[name]?.enabled ?? false,
      // Decrypted only here, at the moment a request is built. Never logged.
      apiKey: () => decryptSecret(this.deps.settings().providers[name]?.apiKey ?? ''),
      timeoutMs: () => this.deps.settings().providers[name]?.timeoutMs ?? 8000,
      minLiquidityUsd: () => this.deps.settings().providers[name]?.minLiquidityUsd ?? 25_000,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    return [
      new CoinMarketCapProvider(opts('coinmarketcap')),
      new CoinGeckoProvider(opts('coingecko')),
      new DexscreenerProvider(opts('dexscreener')),
    ];
  }

  /** Adapters in the operator's configured order, skipping unusable ones. */
  private chain(): PriceProvider[] {
    const order = this.deps.settings().chain;
    const byName = new Map(this.adapters.map((a) => [a.name, a]));
    const out: PriceProvider[] = [];
    for (const name of order) {
      const a = byName.get(name);
      if (a?.isConfigured()) out.push(a);
    }
    return out;
  }

  /** Per-provider rate limit, so one adapter cannot burn another's budget. */
  private allowCall(name: string): boolean {
    const limit = this.deps.settings().providers[name]?.rateLimitPerMinute ?? 30;
    const now = this.now();
    const times = (this.calls.get(name) ?? []).filter((t) => t > now - 60_000);
    if (times.length >= limit) return false;
    times.push(now);
    this.calls.set(name, times);
    return true;
  }

  private noteHealth(name: string, ok: boolean, detail: string): void {
    this.health.set(name, { ok, at: this.now(), detail });
  }

  /* ── Resolution ──────────────────────────────────────────────────────── */

  /**
   * Resolves a symbol to a pinned mapping, asking the chain only when there is
   * no pin yet.
   *
   * A LOCKED mapping short-circuits everything: contested tickers are pinned by
   * the operator and automatic resolution never touches them.
   */
  async resolve(
    symbol: string,
    scope = '*',
  ): Promise<
    | { kind: 'mapping'; mapping: AssetMapping; autoResolved?: boolean }
    | { kind: 'ambiguous'; options: AssetCandidate[]; provider: string }
    | { kind: 'unknown' }
    | { kind: 'unavailable' }
  > {
    const pinned = await findMapping(this.deps.db, symbol, scope);
    if (pinned) {
      void touchMapping(this.deps.db, pinned.id).catch(() => undefined);
      return { kind: 'mapping', mapping: pinned };
    }

    const chain = this.chain();
    if (chain.length === 0) return { kind: 'unavailable' };

    let sawProvider = false;
    for (const provider of chain) {
      if (!provider.capabilities.canResolve) continue;
      if (!this.allowCall(provider.name)) continue;
      try {
        const candidates = await provider.resolveSymbol(symbol);
        sawProvider = true;
        this.noteHealth(provider.name, true, 'resolved');
        if (candidates.length === 0) continue;
        if (candidates.length === 1) {
          const only = candidates[0] as AssetCandidate;
          const mapping = await this.pin(symbol, only, provider.name, 'resolved', scope);
          return { kind: 'mapping', mapping };
        }

        // §4 — rank by the figure that actually separates a real asset from a
        // clone: market capitalisation, or pool liquidity for DEX results.
        const ranked = [...candidates].sort((a, b) => weightOf(b) - weightOf(a));
        const settings = this.deps.settings();

        // Auto-resolve on dominance. Asking whether someone means Bitcoin or
        // "Bitcoin AI" is not a real question, and putting it to a member who
        // cannot be expected to know is worse than deciding.
        const top = ranked[0] as AssetCandidate;
        const runnerUp = ranked[1];
        const factor = settings.dominanceFactor;
        if (factor > 0 && weightOf(top) > 0 && weightOf(top) >= weightOf(runnerUp) * factor) {
          const mapping = await this.pin(symbol, top, provider.name, 'resolved', scope);
          log.info(`Price: "${symbol}" auto-resolved to ${top.name} (dominant by ${factor}x).`);
          return { kind: 'mapping', mapping, autoResolved: true };
        }

        candidates.length = 0;
        candidates.push(...ranked.slice(0, settings.maxCandidates));
        // More than one asset claims the ticker — ask, never choose.
        // The provider is carried along: ids belong to ONE provider's
        // namespace, so the member's pick must be pinned under the same one.
        return { kind: 'ambiguous', options: candidates, provider: provider.name };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.noteHealth(provider.name, false, detail);
        log.warn(`Price: ${provider.name} failed to resolve "${symbol}" (${detail}).`);
      }
    }
    return sawProvider ? { kind: 'unknown' } : { kind: 'unavailable' };
  }

  /** Pins a candidate, learning the id under the provider that produced it. */
  async pin(
    symbol: string,
    candidate: AssetCandidate,
    providerName: string,
    source: 'resolved' | 'member-choice' | 'manual',
    scope = '*',
  ): Promise<AssetMapping> {
    return upsertMapping(this.deps.db, {
      symbol,
      scope,
      displayName: candidate.name || candidate.symbol,
      kind: 'crypto',
      chain: candidate.chain ?? null,
      contract: candidate.contract ?? null,
      decimals: 8,
      providerIds: { [providerName]: candidate.id },
      source,
      resolvedBy: providerName,
    });
  }

  /* ── Quotes ──────────────────────────────────────────────────────────── */

  private cacheKey(mapping: AssetMapping, vs: string): string {
    return `${mapping.id}|${vs.toLowerCase()}`;
  }

  /**
   * A quote for a pinned asset, from the cache when fresh, otherwise from the
   * first provider in the chain that can answer.
   *
   * Failover advances on any adapter failure, including "answered but does not
   * know this asset". Each provider is asked using ITS OWN id — ids are never
   * portable between providers, and reusing one would return the wrong asset's
   * price with full confidence.
   */
  async quote(mapping: AssetMapping, vs: string): Promise<QuoteResult | null> {
    const key = this.cacheKey(mapping, vs);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.storedAt <= this.effectiveTtlMs(hit.quote.provider)) {
      return hit.quote;
    }

    for (const provider of this.chain()) {
      const id = mapping.providerIds[provider.name];
      // Dexscreener identifies by chain+contract rather than an id it owns.
      const usable = id ?? (mapping.chain && mapping.contract ? undefined : null);
      if (usable === null) continue;
      if (!this.allowCall(provider.name)) continue;

      try {
        const q = await provider.fetchQuote(
          {
            ...(id ? { id } : {}),
            symbol: mapping.symbol,
            chain: mapping.chain ?? undefined,
            contract: mapping.contract ?? undefined,
          },
          vs,
        );
        const result: QuoteResult = {
          price: q.price,
          vs: q.vs,
          at: q.at,
          provider: q.provider,
          attribution: provider.capabilities.attribution,
        };
        this.cache.set(key, { quote: result, storedAt: this.now() });
        this.noteHealth(provider.name, true, 'quoted');
        return result;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.noteHealth(provider.name, false, detail);
        if (!(err instanceof ProviderError) || !err.notFound) {
          log.warn(`Price: ${provider.name} failed to quote ${mapping.symbol} (${detail}).`);
        }
      }
    }
    return null;
  }

  /** The configured TTL, capped by what a provider's licence permits. */
  private effectiveTtlMs(providerName: string): number {
    const configured = this.deps.settings().cacheTtlSeconds;
    const cap =
      this.adapters.find((a) => a.name === providerName)?.capabilities.maxCacheSeconds ??
      Number.POSITIVE_INFINITY;
    return Math.min(configured, cap) * 1000;
  }

  /* ── The public question ─────────────────────────────────────────────── */

  /**
   * "What is `amount` of `baseText` worth in `quoteText`?"
   *
   * Fiat quotes are direct. Asset-to-asset is a CROSS RATE through the configured
   * base currency, because direct pairs mostly do not exist.
   */
  async price(
    baseText: string,
    quoteText: string | undefined,
    amount: number,
    scope = '*',
  ): Promise<PriceOutcome> {
    const baseFiat = asFiat(baseText);
    const baseRes = baseFiat ? null : await this.resolve(baseText, scope);
    if (baseRes?.kind === 'ambiguous') {
      return {
        kind: 'ambiguous',
        symbol: baseText,
        options: baseRes.options,
        provider: baseRes.provider,
      };
    }
    if (baseRes?.kind === 'unknown') return { kind: 'unknown-asset', symbol: baseText };
    if (baseRes?.kind === 'unavailable') return { kind: 'unavailable' };
    if (!baseRes && baseFiat) {
      // "what is USD worth" is not a question this answers.
      return { kind: 'unknown-asset', symbol: baseText };
    }
    const base = (baseRes as { kind: 'mapping'; mapping: AssetMapping }).mapping;

    const settings = this.deps.settings();
    const quoteName = quoteText ?? settings.baseCurrency;
    const quoteFiat = asFiat(quoteName);

    if (quoteFiat) {
      const q = await this.quote(base, quoteFiat.symbol.toLowerCase());
      if (q) {
        return {
          kind: 'price',
          amount,
          base,
          quote: quoteFiat,
          value: amount * q.price,
          at: q.at,
          provider: q.provider,
          attribution: q.attribution,
        };
      }
      // Not every provider prices in every fiat (Dexscreener is USD only), so
      // fall back to a cross through the base currency.
      const via = asFiat(settings.baseCurrency);
      if (!via || via.symbol === quoteFiat.symbol) return { kind: 'unavailable' };
      const baseUsd = await this.quote(base, via.symbol.toLowerCase());
      if (!baseUsd) return { kind: 'unavailable' };
      const fx = await this.fiatRate(via.symbol, quoteFiat.symbol);
      if (fx === null) return { kind: 'unavailable' };
      return {
        kind: 'price',
        amount,
        base,
        quote: quoteFiat,
        value: amount * baseUsd.price * fx,
        at: baseUsd.at,
        provider: baseUsd.provider,
        attribution: baseUsd.attribution,
      };
    }

    // Asset → asset: cross through the base currency.
    const otherRes = await this.resolve(quoteName, scope);
    if (otherRes.kind === 'ambiguous') {
      return {
        kind: 'ambiguous',
        symbol: quoteName,
        options: otherRes.options,
        provider: otherRes.provider,
      };
    }
    if (otherRes.kind === 'unknown') return { kind: 'unknown-asset', symbol: quoteName };
    if (otherRes.kind === 'unavailable') return { kind: 'unavailable' };
    const other = otherRes.mapping;

    if (other.id === base.id) {
      return {
        kind: 'price',
        amount,
        base,
        quote: other,
        value: amount,
        at: this.now(),
        provider: 'local',
        attribution: '',
      };
    }

    const via = asFiat(settings.baseCurrency);
    if (!via) return { kind: 'unavailable' };
    const vs = via.symbol.toLowerCase();
    const a = await this.quote(base, vs);
    const b = await this.quote(other, vs);
    if (!a || !b || b.price === 0) return { kind: 'unavailable' };
    return {
      kind: 'conversion',
      amount,
      base,
      quote: other,
      value: (amount * a.price) / b.price,
      at: Math.min(a.at, b.at),
      provider: a.provider === b.provider ? a.provider : `${a.provider}+${b.provider}`,
      // Both legs' credits are owed when they came from different sources.
      attribution: [a.attribution, b.attribution]
        .filter((x, i, arr) => x && arr.indexOf(x) === i)
        .join(' · '),
    };
  }

  /**
   * Fiat-to-fiat rate, priced by asking the chain what one unit of a widely
   * quoted asset is worth in both. Avoids adding an FX provider for the rare
   * case of a non-USD quote from a USD-only source.
   */
  private async fiatRate(from: string, to: string): Promise<number | null> {
    const anchor = await findMapping(this.deps.db, 'BTC');
    if (!anchor) return null;
    const a = await this.quote(anchor, from.toLowerCase());
    const b = await this.quote(anchor, to.toLowerCase());
    if (!a || !b || a.price === 0) return null;
    return b.price / a.price;
  }

  /* ── Diagnostics ─────────────────────────────────────────────────────── */

  cacheSize(): number {
    return this.cache.size;
  }
  clearCache(): void {
    this.cache.clear();
  }
  providerStatus(): {
    name: string;
    label: string;
    configured: boolean;
    note: string;
    health?: { ok: boolean; at: number; detail: string };
  }[] {
    return this.adapters.map((a) => {
      const h = this.health.get(a.name);
      return {
        name: a.name,
        label: a.label,
        configured: a.isConfigured(),
        note: a.capabilities.note,
        ...(h ? { health: h } : {}),
      };
    });
  }
}
