/**
 * Crypto Prices plugin settings (CCB-S3-004 §7), stored under the settings key
 * `plugin:crypto-prices`. Plugin settings live under the plugin, not in the
 * global interaction settings — that is what makes a second plugin free.
 */

import { applySecretUpdate, describeSecret } from '../secrets.js';

export const PROVIDER_ORDER_DEFAULT = ['coinmarketcap', 'coingecko', 'dexscreener'] as const;

export interface ProviderSettings {
  enabled: boolean;
  /** Encrypted, write-only. Never rendered back into the form. */
  apiKey: string;
  timeoutMs: number;
  /** Requests per minute this adapter may make. */
  rateLimitPerMinute: number;
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
    dexscreener: providerDefaults(true),
  },
  baseCurrency: 'USD',
  cacheTtlSeconds: 60,
  rateLimitPerMember: 5,
  rateLimitPerChat: 20,
  // Off by default: what a price message must say differs by country, so
  // enabling it is the operator's decision (same doctrine as D-025).
  disclaimer: '',
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
    const submittedKey = str(p['apiKey'], '', 400);
    providers[name] = {
      enabled: bool(p['enabled'], prev.enabled),
      apiKey: applySecretUpdate(prev.apiKey, submittedKey, bool(p['clearApiKey'], false)),
      timeoutMs: int(p['timeoutMs'], 1000, 30000, prev.timeoutMs),
      rateLimitPerMinute: int(p['rateLimitPerMinute'], 1, 600, prev.rateLimitPerMinute),
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
