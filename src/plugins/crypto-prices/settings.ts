/**
 * Crypto Prices plugin settings (CCB-S3-004 §7), stored under the settings key
 * `plugin:crypto-prices`. Plugin settings live under the plugin, not in the
 * global interaction settings — that is what makes a second plugin free.
 */

import {
  applySecretUpdate,
  describeSecret,
  encryptSecret,
  isEncrypted,
  repairSecret,
} from '../secrets.js';

/**
 * Default chain order (CCB-S3-006 §8). CoinGecko leads: it answers reliably,
 * explicitly permits caching, and needs no key. CoinMarketCap goes last because
 * its free-tier personal-use question is unresolved, so it is rarely consulted
 * without having to be switched off.
 */
export const PROVIDER_ORDER_DEFAULT = ['coingecko', 'dexscreener', 'coinmarketcap'] as const;

export interface ProviderSettings {
  enabled: boolean;
  /** Encrypted, write-only. Never rendered back into the form. */
  apiKey: string;
  timeoutMs: number;
  /** Requests per minute this adapter may make. */
  rateLimitPerMinute: number;
  /** DEX sources only: ignore pools thinner than this, in USD (§5). */
  minLiquidityUsd?: number;
}

export interface CryptoPricesSettings {
  /** Ordered provider chain; earlier entries are tried first. */
  chain: string[];
  providers: Record<string, ProviderSettings>;
  /** Currency prices default to, and that cross rates are computed through. */
  baseCurrency: string;
  cacheTtlSeconds: number;
  rateLimitPerMember: number;
  rateLimitPerChat: number;
  /** Appended to every price reply when set. Off by default. */
  disclaimer: string;
  /** Most candidates ever offered when a symbol is genuinely ambiguous (§4). */
  maxCandidates: number;
  /**
   * Auto-resolve when the leading candidate dwarfs the runner-up by this factor
   * (§4). Asking whether someone means Bitcoin or "Bitcoin AI" is not a real
   * question; 0 disables and always asks.
   */
  dominanceFactor: number;
}

function providerDefaults(enabled: boolean): ProviderSettings {
  return { enabled, apiKey: '', timeoutMs: 8000, rateLimitPerMinute: 30 };
}

export const DEFAULT_CRYPTO_PRICES: CryptoPricesSettings = {
  // The operator holds a CoinMarketCap key, so it leads. It self-skips when no
  // key is set, so an instance without one simply falls through to the others.
  chain: [...PROVIDER_ORDER_DEFAULT],
  providers: {
    coinmarketcap: providerDefaults(true),
    coingecko: providerDefaults(true),
    // Dexscreener documents 60 requests per minute and needs no key (§5).
    dexscreener: { ...providerDefaults(true), rateLimitPerMinute: 60, minLiquidityUsd: 25_000 },
  },
  baseCurrency: 'USD',
  cacheTtlSeconds: 60,
  rateLimitPerMember: 5,
  rateLimitPerChat: 20,
  // Off by default: what a price message must say differs by country, so
  // enabling it is the operator's decision (same doctrine as D-025).
  disclaimer: '',
  maxCandidates: 4,
  dominanceFactor: 100,
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function bool(v: unknown, d: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return d;
}
function int(v: unknown, min: number, max: number, d: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(typeof v === 'string' ? v : '', 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function str(v: unknown, d: string, maxLen: number): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : d;
}

/**
 * Normalises stored or submitted settings.
 *
 * API keys are handled specially: the value already stored is CARRIED FORWARD
 * unless the submission explicitly sets or clears it. That is what makes the
 * field write-only — the form can be saved any number of times without the
 * operator re-pasting the key, and the key never has to leave the server to make
 * a round trip through a browser.
 */
export function normalizeCryptoPrices(
  input: unknown,
  previous: CryptoPricesSettings = DEFAULT_CRYPTO_PRICES,
): CryptoPricesSettings {
  const o = rec(input);
  const d = DEFAULT_CRYPTO_PRICES;
  const provIn = rec(o['providers']);

  const known = Object.keys(d.providers);
  const rawChain = o['chain'];
  const chainList = Array.isArray(rawChain)
    ? rawChain.map((x) => String(x).trim().toLowerCase())
    : typeof rawChain === 'string'
      ? rawChain.split(/[\s,]+/).map((x) => x.trim().toLowerCase())
      : [...previous.chain];
  const chain: string[] = [];
  for (const name of chainList) {
    if (known.includes(name) && !chain.includes(name)) chain.push(name);
  }
  // A provider left out of the order is still available, just last.
  for (const name of known) if (!chain.includes(name)) chain.push(name);

  const providers: Record<string, ProviderSettings> = {};
  for (const name of known) {
    const p = rec(provIn[name]);
    const prev = previous.providers[name] ?? d.providers[name] ?? providerDefaults(true);
    // `apiKey` is the STORED envelope; `apiKeyInput` is what an operator typed.
    // They are separate field names on purpose. When they were one field, loading
    // the stored settings looked exactly like submitting the form, so every boot
    // re-encrypted the key and the providers were handed ciphertext as their
    // credential (CCB-S3-008 §2). A stored value now passes through untouched.
    // NOT length-clamped. Clamping the STORED field truncated long envelopes,
    // and a truncated envelope fails authentication, so the repair below would
    // have written the truncation back and destroyed the key while reporting
    // success.
    const rawStored = typeof p['apiKey'] === 'string' ? p['apiKey'] : '';
    const storedKey = isEncrypted(rawStored)
      ? (repairSecret(rawStored) ?? rawStored)
      : // A value here that is NOT an envelope is a plaintext key that reached
        // the storage field — an older form post, or a hand-edited settings row.
        // It must be encrypted, never passed through: storing it as-is would put
        // a live credential in clear in the settings table and therefore in every
        // backup, while the console reported "no key set".
        rawStored
          ? encryptSecret(rawStored.trim().slice(0, 400))
          : '';
    const typedKey = str(p['apiKeyInput'], '', 400);
    providers[name] = {
      enabled: bool(p['enabled'], prev.enabled),
      apiKey: applySecretUpdate(storedKey || prev.apiKey, typedKey, bool(p['clearApiKey'], false)),
      timeoutMs: int(p['timeoutMs'], 1000, 30000, prev.timeoutMs),
      rateLimitPerMinute: int(p['rateLimitPerMinute'], 1, 600, prev.rateLimitPerMinute),
      minLiquidityUsd: int(p['minLiquidityUsd'], 0, 100_000_000, prev.minLiquidityUsd ?? 0),
    };
  }

  return {
    chain,
    providers,
    baseCurrency:
      str(o['baseCurrency'], previous.baseCurrency, 12).trim().toUpperCase() || d.baseCurrency,
    cacheTtlSeconds: int(o['cacheTtlSeconds'], 5, 3600, previous.cacheTtlSeconds),
    rateLimitPerMember: int(o['rateLimitPerMember'], 1, 120, previous.rateLimitPerMember),
    rateLimitPerChat: int(o['rateLimitPerChat'], 1, 600, previous.rateLimitPerChat),
    disclaimer: str(o['disclaimer'], previous.disclaimer, 300).trim(),
    maxCandidates: int(o['maxCandidates'], 2, 10, previous.maxCandidates),
    dominanceFactor: int(o['dominanceFactor'], 0, 100_000, previous.dominanceFactor),
  };
}

/**
 * What the admin console may see about a provider. Deliberately not the key —
 * only whether one is set, so the operator can tell "configured" from "empty".
 */
export function providerKeyStatus(
  s: CryptoPricesSettings,
  name: string,
): {
  set: boolean;
  length: number;
} {
  return describeSecret(s.providers[name]?.apiKey ?? '');
}
