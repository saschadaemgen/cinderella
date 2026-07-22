/**
 * Price provider seam + the CoinGecko implementation (CCB-S3-004 §3).
 *
 * Callers depend on {@link PriceProvider}, never on CoinGecko, so a second source
 * can be added or the first replaced without touching the service, the engine or
 * the resolver — the same seam discipline as the intent resolver.
 *
 * THE ONE RULE HERE: never invent a price. A provider that times out, rate-limits
 * us, or answers with something unparseable returns a failure, and the failure
 * reaches the member as "I cannot reach the market right now". A silently stale
 * or fabricated number in a channel where people discuss money is worse than no
 * answer at all.
 */

import { log } from '../log.js';

/** A quote in a single currency, as the provider gave it. */
export interface Quote {
  /** Canonical provider id of the asset. */
  id: string;
  /** Canonical id of the currency it is priced in (`usd`). */
  vs: string;
  price: number;
  /** When the PROVIDER says this price was current (epoch ms). */
  at: number;
}

export interface PriceProvider {
  /** Identifies the implementation in logs and in the console. */
  readonly name: string;
  /**
   * Fetches prices for several assets in one currency. Throws on failure —
   * callers turn that into an honest "cannot reach the market", never a guess.
   */
  fetchPrices(ids: string[], vs: string): Promise<Quote[]>;
}

export interface CoinGeckoOptions {
  /** Optional API key; the free endpoint works without one. */
  apiKey?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Base URL override (harness). */
  baseUrl?: string;
  /** Injectable fetch (harness). */
  fetchImpl?: typeof fetch;
}

interface SimplePriceResponse {
  [id: string]: { [vs: string]: number } & { last_updated_at?: number };
}

/**
 * CoinGecko's `/simple/price`. Chosen because the free endpoint needs no
 * account, which keeps a self-hosted instance self-hosted.
 */
export class CoinGeckoProvider implements PriceProvider {
  readonly name = 'coingecko';

  constructor(private readonly opts: CoinGeckoOptions = {}) {}

  async fetchPrices(ids: string[], vs: string): Promise<Quote[]> {
    if (ids.length === 0) return [];
    const base = this.opts.baseUrl ?? 'https://api.coingecko.com/api/v3';
    const url = new URL(`${base}/simple/price`);
    url.searchParams.set('ids', ids.join(','));
    url.searchParams.set('vs_currencies', vs);
    url.searchParams.set('include_last_updated_at', 'true');

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.opts.apiKey) headers['x-cg-demo-api-key'] = this.opts.apiKey;

    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
    let res: Response;
    try {
      res = await doFetch(url.toString(), { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`provider responded ${res.status}`);
    }
    const body = (await res.json()) as SimplePriceResponse;

    const now = Date.now();
    const quotes: Quote[] = [];
    for (const id of ids) {
      const row = body[id];
      const price = row?.[vs];
      // A missing or non-finite price is a MISS, not a zero. Emitting 0 here
      // would render as a real answer of "worth about 0".
      if (typeof price !== 'number' || !Number.isFinite(price)) {
        log.debug(`Price: provider returned no usable ${vs} price for "${id}".`);
        continue;
      }
      quotes.push({
        id,
        vs,
        price,
        at: typeof row?.last_updated_at === 'number' ? row.last_updated_at * 1000 : now,
      });
    }
    return quotes;
  }
}
