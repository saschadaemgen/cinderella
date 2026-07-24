/**
 * The three price adapters (CCB-S3-004 §2). Each was checked against the live
 * API and the current published terms rather than from recollection.
 */

import { log } from '../../../log.js';
import {
  httpJson,
  ProviderError,
  type AssetCandidate,
  type AssetRef,
  type PriceProvider,
  type ProviderCapabilities,
  type ProviderQuote,
} from './types.js';

export interface AdapterOptions {
  enabled: () => boolean;
  /** Decrypted key, or '' when none is set. Never logged. */
  apiKey: () => string;
  timeoutMs: () => number;
  /** DEX sources only: the configured liquidity floor (§5). */
  minLiquidityUsd?: () => number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Stringify only what is genuinely a string or number; never an object. */
function s(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return fallback;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/* ── CoinMarketCap ───────────────────────────────────────────────────────── */

/**
 * CoinMarketCap. Requires a key for quotes (verified: keyless returns 403
 * `error_code 1002`).
 *
 * Its `/v1/cryptocurrency/map` is the best contested-ticker disambiguator of the
 * three, because each candidate carries `platform.slug` and `platform.token_address`
 * — which is how HEX-on-Ethereum and HEX-on-PulseChain become distinguishable
 * despite sharing a contract address.
 *
 * LICENCE NOTE, surfaced in the console rather than buried here: CoinMarketCap's
 * free Basic tier falls under an agreement that licenses the data for personal
 * use and forbids making it available to third parties. A bot posting quotes into
 * a group is arguably exactly that. Their live pricing table now labels Basic
 * "Commercial use", so the position is genuinely unclear. The operator decides;
 * the console says so plainly next to the switch.
 */
export class CoinMarketCapProvider implements PriceProvider {
  readonly name = 'coinmarketcap';
  readonly label = 'CoinMarketCap';
  readonly capabilities: ProviderCapabilities = {
    canResolve: true,
    requiresKey: true,
    // Prices by an id of its own, never by a contract address.
    pricesByContract: false,
    attribution: 'Data provided by CoinMarketCap.com',
    maxCacheSeconds: Number.POSITIVE_INFINITY,
    note: 'Best at telling apart tokens that share a ticker. Needs an API key. Check your plan permits showing the data to a group.',
  };

  constructor(private readonly opts: AdapterOptions) {}

  isConfigured(): boolean {
    return this.opts.enabled() && this.opts.apiKey() !== '';
  }

  private base(): string {
    return this.opts.baseUrl ?? 'https://pro-api.coinmarketcap.com';
  }

  private headers(): Record<string, string> {
    // Header form only: the querystring alternative is discouraged for
    // production and would put the key in logs and proxy traces.
    return { 'X-CMC_PRO_API_KEY': this.opts.apiKey() };
  }

  async resolveSymbol(symbol: string): Promise<AssetCandidate[]> {
    const url = `${this.base()}/v1/cryptocurrency/map?symbol=${encodeURIComponent(symbol)}`;
    let body: unknown;
    try {
      body = await httpJson(url, {
        headers: this.headers(),
        timeoutMs: this.opts.timeoutMs(),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }
    const data = rec(body)['data'];
    if (!Array.isArray(data)) return [];
    return data
      .map((raw) => {
        const r = rec(raw);
        const platform = rec(r['platform']);
        const c: AssetCandidate = {
          id: s(r['id']),
          symbol: s(r['symbol'], symbol),
          name: s(r['name']),
        };
        const slug = platform['slug'];
        const addr = platform['token_address'];
        if (typeof slug === 'string' && slug) c.chain = slug;
        if (typeof addr === 'string' && addr) c.contract = addr;
        const rank = num(r['rank']);
        if (rank !== undefined) c.rank = rank;
        return c;
      })
      .filter((c) => c.id !== '');
  }

  async fetchQuote(ref: AssetRef, vs: string): Promise<ProviderQuote> {
    if (!ref.id) throw new ProviderError(this.name, 'no CoinMarketCap id pinned', true);
    // Query by ID, never by symbol: the by-symbol form returns an array of every
    // asset sharing the ticker, which is the collision this whole design avoids.
    const url =
      `${this.base()}/v2/cryptocurrency/quotes/latest` +
      `?id=${encodeURIComponent(ref.id)}&convert=${encodeURIComponent(vs.toUpperCase())}`;
    let body: unknown;
    try {
      body = await httpJson(url, {
        headers: this.headers(),
        timeoutMs: this.opts.timeoutMs(),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }
    const entry = rec(rec(body)['data'])[ref.id];
    const quote = rec(rec(rec(entry)['quote'])[vs.toUpperCase()]);
    const price = num(quote['price']);
    if (price === undefined) throw new ProviderError(this.name, 'no price in response', true);
    const updated = quote['last_updated'];
    return {
      price,
      vs: vs.toLowerCase(),
      at: typeof updated === 'string' ? Date.parse(updated) || Date.now() : Date.now(),
      provider: this.name,
    };
  }
}

/* ── CoinGecko ───────────────────────────────────────────────────────────── */

/**
 * CoinGecko. Keyless (verified), which makes it the friction-free fallback, but
 * the keyless rate limit is per-IP and low — and this product runs on a shared
 * host, so that budget is shared with every neighbour on the address. An optional
 * demo key raises it.
 *
 * Two details that produce wrong output if missed: `precision=full` is required
 * or micro-cap prices are truncated to `0`, and `/simple/price` silently OMITS
 * ids it does not know rather than erroring, so a missing key must be treated as
 * a miss and not as `undefined`.
 */
export class CoinGeckoProvider implements PriceProvider {
  readonly name = 'coingecko';
  readonly label = 'CoinGecko';
  readonly capabilities: ProviderCapabilities = {
    canResolve: true,
    requiresKey: false,
    // Prices by an id of its own, never by a contract address.
    pricesByContract: false,
    attribution: 'Powered by CoinGecko',
    // Their terms require cached data to be refreshed at least daily.
    maxCacheSeconds: 24 * 60 * 60,
    note: 'Keyless, but the free rate limit is per IP and low on a shared host. Their licence requires the "Powered by CoinGecko" credit on every reply.',
  };

  constructor(private readonly opts: AdapterOptions) {}

  isConfigured(): boolean {
    return this.opts.enabled();
  }

  private base(): string {
    return this.opts.baseUrl ?? 'https://api.coingecko.com/api/v3';
  }

  private headers(): Record<string, string> {
    const key = this.opts.apiKey();
    return key ? { 'x-cg-demo-api-key': key } : {};
  }

  async resolveSymbol(symbol: string): Promise<AssetCandidate[]> {
    const url = `${this.base()}/search?query=${encodeURIComponent(symbol)}`;
    let body: unknown;
    try {
      body = await httpJson(url, {
        headers: this.headers(),
        timeoutMs: this.opts.timeoutMs(),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }
    const coins = rec(body)['coins'];
    if (!Array.isArray(coins)) return [];
    const want = symbol.trim().toLowerCase();
    const candidates = coins
      .map((raw) => rec(raw))
      // Their search matches names loosely, so filter to an exact ticker match
      // ourselves or "hex" pulls in everything with "hex" in its name.
      .filter((r) => s(r['symbol']).toLowerCase() === want)
      .map((r) => {
        const c: AssetCandidate = {
          id: s(r['id']),
          symbol: s(r['symbol'], symbol),
          name: s(r['name']),
        };
        const rank = num(r['market_cap_rank']);
        if (rank !== undefined) c.rank = rank;
        return c;
      })
      .filter((c) => c.id !== '');

    // Search returns no market cap, and rank is null for exactly the micro caps
    // that need distinguishing (§4). One extra call buys the real figure, which
    // is both the ranking key and what the member is shown when asked to choose.
    return this.withMarketCaps(candidates.slice(0, 10));
  }

  private async withMarketCaps(candidates: AssetCandidate[]): Promise<AssetCandidate[]> {
    if (candidates.length < 2) return candidates;
    try {
      const ids = candidates.map((c) => c.id).join(',');
      const body = await httpJson(
        `${this.base()}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}` +
          `&per_page=${candidates.length}&sparkline=false`,
        {
          headers: this.headers(),
          timeoutMs: this.opts.timeoutMs(),
          ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        },
      );
      if (Array.isArray(body)) {
        const caps = new Map<string, number>();
        for (const raw of body) {
          const r = rec(raw);
          const cap = num(r['market_cap']);
          if (cap !== undefined) caps.set(s(r['id']), cap);
        }
        for (const c of candidates) {
          const cap = caps.get(c.id);
          if (cap !== undefined) c.marketCap = cap;
        }
      }
    } catch (err) {
      // Ranking degrades to rank order; never fail a lookup over a nicety. But not
      // silently (CCB-S3-023): a swallowed /coins/markets failure would leave the
      // provider looking healthy while contested tickers rank wrongly and can pin
      // the wrong asset. Log it so a degraded ranking is distinguishable.
      log.warn(
        `CoinGecko: market-cap enrichment for ranking failed (${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to rank order for this disambiguation.`,
      );
    }
    return candidates;
  }

  async fetchQuote(ref: AssetRef, vs: string): Promise<ProviderQuote> {
    if (!ref.id) throw new ProviderError(this.name, 'no CoinGecko id pinned', true);
    const url =
      `${this.base()}/simple/price?ids=${encodeURIComponent(ref.id)}` +
      `&vs_currencies=${encodeURIComponent(vs.toLowerCase())}` +
      // Without precision=full a sub-cent token renders as 0.
      `&include_last_updated_at=true&precision=full`;
    let body: unknown;
    try {
      body = await httpJson(url, {
        headers: this.headers(),
        timeoutMs: this.opts.timeoutMs(),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }
    const row = rec(rec(body)[ref.id]);
    const price = num(row[vs.toLowerCase()]);
    // An omitted id is a MISS, not a zero.
    if (price === undefined) throw new ProviderError(this.name, 'id not priced', true);
    const updated = num(row['last_updated_at']);
    return {
      price,
      vs: vs.toLowerCase(),
      at: updated !== undefined ? updated * 1000 : Date.now(),
      provider: this.name,
    };
  }
}

/* ── Dexscreener ─────────────────────────────────────────────────────────── */

/** Fallback floor when the operator has not set one; a thin pool is trivially manipulated. */
const DEFAULT_MIN_LIQUIDITY_USD = 25_000;

/**
 * Dexscreener — on-chain pair data, for the thinly traded tokens the aggregators
 * list poorly. Keyless, no attribution required.
 *
 * THE CHAIN-SCOPED ENDPOINT IS MANDATORY. Ethereum HEX and PulseChain HEX share
 * an identical contract address, and the PulseChain pools are deeper — so the
 * address-only lookup returns the PulseChain price for a question about
 * Ethereum HEX, roughly 2.4x wrong, with no error. Pricing therefore always goes
 * through `/tokens/v1/{chain}/{address}`.
 *
 * Pool choice is deliberate rather than "first result": pools below a liquidity
 * floor are discarded and the deepest remaining one wins.
 */
export class DexscreenerProvider implements PriceProvider {
  readonly name = 'dexscreener';
  readonly label = 'Dexscreener';
  readonly capabilities: ProviderCapabilities = {
    canResolve: true,
    requiresKey: false,
    // The only source here that prices by chain + contract.
    pricesByContract: true,
    attribution: '',
    maxCacheSeconds: Number.POSITIVE_INFINITY,
    note: 'Keyless on-chain pair data; the best source for thin tokens. Needs the chain, because forked chains reuse contract addresses.',
  };

  constructor(private readonly opts: AdapterOptions) {}

  isConfigured(): boolean {
    return this.opts.enabled();
  }

  private base(): string {
    return this.opts.baseUrl ?? 'https://api.dexscreener.com';
  }

  private get(url: string): Promise<unknown> {
    return httpJson(url, {
      timeoutMs: this.opts.timeoutMs(),
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });
  }

  async resolveSymbol(symbol: string): Promise<AssetCandidate[]> {
    let body: unknown;
    try {
      body = await this.get(`${this.base()}/latest/dex/search?q=${encodeURIComponent(symbol)}`);
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }
    const pairs = rec(body)['pairs'];
    if (!Array.isArray(pairs)) return [];

    const want = symbol.trim().toLowerCase();
    // One candidate per (chain, token), keeping the deepest pool's figures.
    const best = new Map<string, AssetCandidate & { liquidity: number }>();
    for (const raw of pairs) {
      const p = rec(raw);
      const baseToken = rec(p['baseToken']);
      if (s(baseToken['symbol']).toLowerCase() !== want) continue;
      const chain = s(p['chainId']);
      const contract = s(baseToken['address']);
      if (!chain || !contract) continue;
      const liquidity = num(rec(p['liquidity'])['usd']) ?? 0;
      const key = `${chain}:${contract.toLowerCase()}`;
      const existing = best.get(key);
      if (existing && existing.liquidity >= liquidity) continue;
      best.set(key, {
        // The identity IS the chain+contract; there is no provider-side id.
        id: `${chain}:${contract}`,
        symbol: s(baseToken['symbol'], symbol),
        name: s(baseToken['name'], symbol),
        chain,
        contract,
        volume24h: num(rec(p['volume'])['h24']) ?? 0,
        liquidity,
      });
    }
    return [...best.values()].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
  }

  async fetchQuote(ref: AssetRef, vs: string): Promise<ProviderQuote> {
    // Dexscreener prices in USD only; anything else is crossed upstream.
    if (vs.toLowerCase() !== 'usd') {
      throw new ProviderError(this.name, 'only USD is priced directly', true);
    }
    const chain = ref.chain ?? ref.id?.split(':')[0];
    const contract = ref.contract ?? ref.id?.split(':')[1];
    if (!chain || !contract) {
      // Without a chain this cannot be answered safely — see the class comment.
      throw new ProviderError(this.name, 'needs chain and contract', true);
    }

    let body: unknown;
    try {
      body = await this.get(
        `${this.base()}/tokens/v1/${encodeURIComponent(chain)}/${encodeURIComponent(contract)}`,
      );
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }

    // This endpoint returns a BARE ARRAY, unlike the /latest/dex/* ones.
    const pairs = Array.isArray(body) ? body : (rec(body)['pairs'] as unknown[] | undefined);
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new ProviderError(this.name, 'no pairs for token', true);
    }

    let chosen: { price: number; liquidity: number; at: number } | undefined;
    for (const raw of pairs) {
      const p = rec(raw);
      if (s(p['chainId']).toLowerCase() !== chain.toLowerCase()) continue;
      if (s(rec(p['baseToken'])['address']).toLowerCase() !== contract.toLowerCase()) {
        continue;
      }
      const price = num(p['priceUsd']); // a STRING in their payload
      if (price === undefined) continue;
      const liquidity = num(rec(p['liquidity'])['usd']) ?? 0;
      if (liquidity < (this.opts.minLiquidityUsd?.() ?? DEFAULT_MIN_LIQUIDITY_USD)) continue;
      if (!chosen || liquidity > chosen.liquidity) {
        chosen = { price, liquidity, at: num(p['pairCreatedAt']) ?? Date.now() };
      }
    }
    if (!chosen) throw new ProviderError(this.name, 'no pool above the liquidity floor', true);
    return { price: chosen.price, vs: 'usd', at: Date.now(), provider: this.name };
  }
}
