/**
 * Plugin state + per-plugin settings (CCB-S3-004 §0).
 *
 * Enablement lives under the `plugins` settings key; each plugin's own settings
 * live under `plugin:<id>`. Keeping them separate is what lets a plugin own its
 * schema without the core settings model knowing anything about it.
 *
 * Whenever enablement changes, the ACTIVE INTENT CATALOG is recomputed. That is
 * the mechanism behind "a disabled plugin registers no intents": it is not a
 * check inside a handler, it is the absence of the intent from the catalog the
 * resolver validates against.
 */

import { getSetting, setSetting } from '../db/settings.js';
import type { Queryable } from '../db/pool.js';
import { writeAudit } from '../db/audit.js';
import { setActiveIntents } from '../interaction/intent.js';
import {
  activePluginIntents,
  isPluginEnabled,
  listPlugins,
  normalizePluginStates,
  type PluginStates,
} from './registry.js';
import {
  DEFAULT_CRYPTO_PRICES,
  normalizeCryptoPrices,
  type CryptoPricesSettings,
} from './crypto-prices/settings.js';
// Importing the plugin module is what registers it. Every plugin is imported
// here, which is the single place a new one is added.
import { CRYPTO_PRICES_ID } from './crypto-prices/plugin.js';

const STATES_KEY = 'plugins';
const settingsKey = (id: string): string => `plugin:${id}`;

export class PluginService {
  private constructor(
    private readonly db: Queryable,
    private states: PluginStates,
    private cryptoPrices: CryptoPricesSettings,
  ) {
    this.applyIntents();
  }

  static async load(db: Queryable): Promise<PluginService> {
    const states = normalizePluginStates((await getSetting(db, STATES_KEY)) ?? {});
    const crypto = normalizeCryptoPrices(
      (await getSetting(db, settingsKey(CRYPTO_PRICES_ID))) ?? {},
      DEFAULT_CRYPTO_PRICES,
    );
    return new PluginService(db, states, crypto);
  }

  /** All-defaults instance, for harnesses and the server's fallback path. */
  static withDefaults(db: Queryable): PluginService {
    return new PluginService(db, normalizePluginStates({}), normalizeCryptoPrices({}));
  }

  private applyIntents(): void {
    setActiveIntents(activePluginIntents(this.states));
  }

  getStates(): PluginStates {
    return { ...this.states };
  }

  isEnabled(id: string): boolean {
    return isPluginEnabled(this.states, id);
  }

  list(): {
    id: string;
    name: string;
    description: string;
    version: string;
    adminPath: string;
    enabled: boolean;
  }[] {
    return listPlugins().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      version: p.version,
      adminPath: p.adminPath,
      enabled: this.isEnabled(p.id),
    }));
  }

  async setEnabled(id: string, enabled: boolean, actor: string): Promise<void> {
    this.states = normalizePluginStates({ ...this.states, [id]: { enabled } });
    await setSetting(this.db, STATES_KEY, this.states);
    await writeAudit(this.db, actor, 'plugin.toggle', `plugin:${id}`, { enabled });
    // The catalog changes immediately: a disabled plugin's intents disappear
    // without a restart.
    this.applyIntents();
  }

  /* ── Crypto Prices settings ─────────────────────────────────────────── */

  getCryptoPrices(): CryptoPricesSettings {
    return this.cryptoPrices;
  }

  /**
   * Saves the plugin's settings. The PREVIOUS value is passed to normalisation
   * so an untouched write-only API key field carries the stored key forward
   * instead of blanking it.
   */
  async saveCryptoPrices(next: unknown, actor: string): Promise<CryptoPricesSettings> {
    const normalized = normalizeCryptoPrices(next, this.cryptoPrices);
    await setSetting(this.db, settingsKey(CRYPTO_PRICES_ID), normalized);
    // The audit detail deliberately omits every API key.
    await writeAudit(this.db, actor, 'plugin.settings', `plugin:${CRYPTO_PRICES_ID}`, {
      chain: normalized.chain,
      baseCurrency: normalized.baseCurrency,
      cacheTtlSeconds: normalized.cacheTtlSeconds,
      rateLimitPerMember: normalized.rateLimitPerMember,
      rateLimitPerChat: normalized.rateLimitPerChat,
      disclaimerSet: normalized.disclaimer !== '',
      providers: Object.fromEntries(
        Object.entries(normalized.providers).map(([k, v]) => [
          k,
          { enabled: v.enabled, keySet: v.apiKey !== '', timeoutMs: v.timeoutMs },
        ]),
      ),
    });
    this.cryptoPrices = normalized;
    return normalized;
  }
}
