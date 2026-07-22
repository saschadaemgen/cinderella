/**
 * The plugin registry (CCB-S3-004 §0).
 *
 * Cinderella is meant to grow into a suite, so capabilities beyond the core
 * archive arrive as PLUGINS: each declares who it is, whether it is enabled, the
 * intents it contributes to the resolver, and where its settings page lives.
 *
 * The framework is deliberately thin. It has to carry a plugin, not become one.
 * Adding a second plugin is a `definePlugin` call and a settings page — no change
 * to the sidebar, the resolver, or the settings framework.
 *
 * THE LOAD-BEARING RULE: a disabled plugin registers NO intents. Not "registers
 * them and refuses to act" — the intents are absent from the active catalog, so
 * the rule engine never matches their patterns and the resolver seam downgrades
 * anything claiming them to UNKNOWN. A half-wired handler behind a disabled
 * switch is exactly the sort of thing that answers a question it should not.
 */

import type { Intent } from '../interaction/intent.js';

export interface PluginDefinition {
  /** Stable slug; also the settings key and the URL segment. */
  id: string;
  name: string;
  /** One line, shown in the plugin list. */
  description: string;
  version: string;
  /** Whether it is on when nobody has said otherwise. */
  defaultEnabled: boolean;
  /**
   * Intents this plugin contributes to the closed catalog. They exist in the
   * catalog only while the plugin is enabled.
   */
  intents: readonly Intent[];
  /** Admin page path. */
  adminPath: string;
}

const definitions = new Map<string, PluginDefinition>();

/** Registers a plugin. Called once per plugin at module load. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  definitions.set(def.id, def);
  return def;
}

export function listPlugins(): PluginDefinition[] {
  return [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getPlugin(id: string): PluginDefinition | undefined {
  return definitions.get(id);
}

/** Per-plugin enablement, stored under the `plugins` settings key. */
export type PluginStates = Record<string, { enabled: boolean }>;

export function normalizePluginStates(input: unknown): PluginStates {
  const src =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const out: PluginStates = {};
  for (const def of listPlugins()) {
    const row = src[def.id];
    const enabled =
      row && typeof row === 'object' && 'enabled' in (row as Record<string, unknown>)
        ? Boolean((row as { enabled?: unknown }).enabled)
        : def.defaultEnabled;
    out[def.id] = { enabled };
  }
  return out;
}

export function isPluginEnabled(states: PluginStates, id: string): boolean {
  const def = definitions.get(id);
  if (!def) return false;
  return states[id]?.enabled ?? def.defaultEnabled;
}

/**
 * The intents contributed by currently-enabled plugins. The interaction layer
 * feeds this into the active catalog; see `interaction/intent.ts`.
 */
export function activePluginIntents(states: PluginStates): Intent[] {
  const out: Intent[] = [];
  for (const def of listPlugins()) {
    if (!isPluginEnabled(states, def.id)) continue;
    out.push(...def.intents);
  }
  return out;
}

/** Test hook. */
export function clearPlugins(): void {
  definitions.clear();
}
