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

import { log } from '../log.js';
import { getSetting, setSetting } from '../db/settings.js';
import { secretLayers } from './secrets.js';
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

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

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
    const stored = (await getSetting(db, settingsKey(CRYPTO_PRICES_ID))) ?? {};
    const crypto = normalizeCryptoPrices(stored, DEFAULT_CRYPTO_PRICES);

    // Self-repair for instances written by the doubled-encryption path
    // (CCB-S3-008 §2). The normalizer has already unwrapped the extra layers in
    // memory; persisting them here means it happens once rather than on every
    // boot. The count is logged and the value never is.
    // Detected by LAYER COUNT, not by comparing ciphertext: every encryption uses
    // a fresh IV, so a string comparison differs even when nothing was wrong, and
    // this would rewrite the settings on every single boot.
    const before = rec(rec(stored)['providers']);
    const repaired = Object.keys(crypto.providers).filter(
      (name) => secretLayers(str(rec(before[name])['apiKey'])) > 1,
    );
    if (repaired.length > 0) {
      // NON-FATAL. `load()` used to be read-only and is awaited unguarded during
      // boot; a settings table that will not take a write must not stop the bot
      // from starting. The in-memory value is already correct either way, so the
      // worst case is that the repair is redone on the next boot.
      try {
        await setSetting(db, settingsKey(CRYPTO_PRICES_ID), crypto);
        // Audited like every other settings write. Provider names only — never a
        // key, and never a layer's contents.
        await writeAudit(db, 'system', 'plugin.secret.repair', `plugin:${CRYPTO_PRICES_ID}`, {
          providers: repaired,
        });
        log.warn(
          `Repaired ${repaired.length} provider key(s) that had been encrypted more than once ` +
            `(${repaired.join(', ')}). Those providers were being sent an unusable credential ` +
            `until now.`,
        );
      } catch (err) {
        log.error(
          `Could not persist the repaired provider key(s) (${
            err instanceof Error ? err.message : String(err)
          }). They are correct in memory; the repair will be retried on the next start.`,
        );
      }
    }
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
