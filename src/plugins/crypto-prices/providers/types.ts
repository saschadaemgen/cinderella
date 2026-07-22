/**
 * The price-provider seam (CCB-S3-004 §2).
 *
 * Three adapters implement this: CoinMarketCap, CoinGecko and Dexscreener. Adding
 * a fourth touches no caller. The chain in `chain.ts` tries them in the operator's
 * order and fails over.
 *
 * Two things every adapter must get right, both learned from checking the
 * providers rather than assuming:
 *
 *  - **Attribution is a licence term, not a courtesy.** CoinGecko requires
 *    "Powered by CoinGecko" and CoinMarketCap requires "Data provided by
 *    CoinMarketCap.com" wherever their data is shown. A chat group has no footer
 *    to hide that in, so the string rides on the quote itself and is emitted in
 *    the reply — and because failover means the answering provider is not
 *    necessarily the first one tried, it can never be a static template.
 *  - **Identity is (chain, contract), not a ticker.** Ethereum HEX and PulseChain
 *    HEX share an IDENTICAL contract address, because PulseChain is an Ethereum
 *    state fork. An adapter that resolves a token address without pinning the
 *    chain returns a confidently wrong price.
 */

/** A candidate asset a provider offers for a symbol. */
export interface AssetCandidate {
  /** This provider's own id for the asset. Never portable to another provider. */
  id: string;
  symbol: string;
  name: string;
  /** Chain slug, where the provider knows one. Native coins have none. */
  chain?: string;
  /** Token contract address, where there is one. */
  contract?: string;
  /** Provider's popularity/rank signal, where offered. Lower is better. */
  rank?: number;
  /** 24h volume in USD, where offered — the better tiebreaker for micro caps. */
  volume24h?: number;
  /** Market capitalisation in USD, where the provider offers it (§4). */
  marketCap?: number;
  /** Pool liquidity in USD, for DEX results (§4). */
  liquidity?: number;
}

/** A price, and the evidence for where it came from. */
export interface ProviderQuote {
  price: number;
  /** Currency the price is expressed in, lowercased (`usd`). */
  vs: string;
  /** When the provider says the price was current (epoch ms). */
  at: number;
  /** Which provider answered — the operator sees this in diagnostics. */
  provider: string;
}

export interface ProviderCapabilities {
  /** Whether this adapter can resolve a bare symbol to candidates. */
  canResolve: boolean;
  /** Whether it needs an API key to answer at all. */
  requiresKey: boolean;
  /**
   * Attribution text this provider's licence requires wherever its data is
   * shown. Empty when none is required. Appended to the reply verbatim.
   */
  attribution: string;
  /**
   * Hard ceiling on how long a quote from this provider may be cached, in
   * seconds. CoinGecko's terms require a refresh at least every 24h; others are
   * unconstrained, so this is Infinity and the configured TTL governs.
   */
  maxCacheSeconds: number;
  /** Notes shown next to the provider in the console. */
  note: string;
  /** Ignore DEX pools thinner than this, in USD. Ignored by non-DEX sources. */
  minLiquidityUsd?: number;
}

export interface PriceProvider {
  /** Stable slug, also the key under which its settings and ids are stored. */
  readonly name: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  /** Is this adapter usable right now (enabled, key present if required)? */
  isConfigured(): boolean;

  /**
   * Finds the assets this provider thinks a symbol could mean. Returning more
   * than one is normal and is what drives the disambiguation question.
   */
  resolveSymbol(symbol: string): Promise<AssetCandidate[]>;

  /**
   * Prices an asset this provider already knows by id. `chain` and `contract`
   * are passed through because for on-chain sources the id alone is ambiguous
   * across forked chains.
   */
  fetchQuote(ref: AssetRef, vs: string): Promise<ProviderQuote>;
}

/** Everything an adapter may need to price an asset it has been pinned to. */
export interface AssetRef {
  /** This provider's id for the asset, if one has been pinned. */
  id?: string;
  symbol: string;
  chain?: string | undefined;
  contract?: string | undefined;
}

/** Thrown when an adapter cannot answer; the chain moves to the next provider. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    /** True when the provider answered fine but does not know this asset. */
    readonly notFound = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Shared fetch helper with a timeout, used by every adapter. */
export async function httpJson(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json', 'user-agent': 'Cinderella/1.0', ...opts.headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
