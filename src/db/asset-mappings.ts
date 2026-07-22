/**
 * Persistent symbol → asset mappings (CCB-S3-004 §1).
 *
 * A mapping is pinned once and reused forever. The alternative — resolving the
 * ticker at the provider on every request — looks harmless and is not: search
 * rankings move, so the same question can return a different token's price on a
 * later day, silently. Pinning makes the answer reproducible and makes any
 * change to it a deliberate, visible act by the operator.
 *
 * Scope is `'*'` (global) for essentially everything. HEX is HEX regardless of
 * which group asks. A group id may be used instead for a genuine per-community
 * exception; the lookup prefers the specific one and falls back to global.
 */

import type { Queryable } from './pool.js';

export type MappingSource = 'seed' | 'manual' | 'resolved' | 'member-choice';
export type AssetKind = 'crypto' | 'fiat';

/** The global scope marker. */
export const GLOBAL_SCOPE = '*';

export interface AssetMapping {
  id: number;
  symbol: string;
  scope: string;
  displayName: string;
  kind: AssetKind;
  chain: string | null;
  contract: string | null;
  decimals: number;
  /** Provider name → that provider's id for this asset. */
  providerIds: Record<string, string>;
  source: MappingSource;
  locked: boolean;
  resolvedBy: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  symbol: string;
  scope: string;
  display_name: string;
  kind: string;
  chain: string | null;
  contract: string | null;
  decimals: number;
  provider_ids: unknown;
  source: string;
  locked: boolean;
  resolved_by: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: Row): AssetMapping {
  const ids: Record<string, string> = {};
  if (r.provider_ids && typeof r.provider_ids === 'object') {
    for (const [k, v] of Object.entries(r.provider_ids as Record<string, unknown>)) {
      if (typeof v === 'string' && v) ids[k] = v;
    }
  }
  return {
    id: Number(r.id),
    symbol: r.symbol,
    scope: r.scope,
    displayName: r.display_name,
    kind: r.kind === 'fiat' ? 'fiat' : 'crypto',
    chain: r.chain,
    contract: r.contract,
    decimals: Number(r.decimals),
    providerIds: ids,
    source: r.source as MappingSource,
    locked: r.locked,
    resolvedBy: r.resolved_by,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, symbol, scope, display_name, kind, chain, contract, decimals,
                 provider_ids, source, locked, resolved_by, last_used_at, created_at, updated_at`;

export function normalizeSymbolKey(s: string): string {
  return s.trim().toUpperCase();
}

/**
 * The mapping for a symbol: a community-specific override if one exists,
 * otherwise the global pin. Returns null when the symbol has never been resolved.
 */
export async function findMapping(
  db: Queryable,
  symbol: string,
  scope: string = GLOBAL_SCOPE,
): Promise<AssetMapping | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM asset_mappings
     WHERE symbol = $1 AND scope IN ($2, $3)
     -- A community override outranks the global pin.
     ORDER BY (scope <> $3) DESC
     LIMIT 1`,
    [normalizeSymbolKey(symbol), scope, GLOBAL_SCOPE],
  );
  const r = rows[0];
  return r ? mapRow(r) : null;
}

export interface UpsertMapping {
  symbol: string;
  scope?: string;
  displayName: string;
  kind?: AssetKind;
  chain?: string | null;
  contract?: string | null;
  decimals?: number;
  providerIds: Record<string, string>;
  source: MappingSource;
  locked?: boolean;
  resolvedBy?: string | null;
}

/**
 * Pins a mapping. Re-pinning merges provider ids rather than replacing them, so
 * learning CoinGecko's id for an asset already known to CoinMarketCap does not
 * throw the first one away.
 *
 * A LOCKED row is never overwritten by anything other than an explicit operator
 * edit — that is what "manual override" means, and it is why automatic
 * resolution can never quietly repoint a contested ticker.
 */
export async function upsertMapping(db: Queryable, m: UpsertMapping): Promise<AssetMapping> {
  const scope = m.scope ?? GLOBAL_SCOPE;
  const { rows } = await db.query<Row>(
    `INSERT INTO asset_mappings
       (symbol, scope, display_name, kind, chain, contract, decimals, provider_ids,
        source, locked, resolved_by, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, now())
     ON CONFLICT (symbol, scope) DO UPDATE SET
       display_name = CASE WHEN asset_mappings.locked THEN asset_mappings.display_name
                           ELSE EXCLUDED.display_name END,
       kind         = CASE WHEN asset_mappings.locked THEN asset_mappings.kind
                           ELSE EXCLUDED.kind END,
       chain        = CASE WHEN asset_mappings.locked THEN asset_mappings.chain
                           ELSE EXCLUDED.chain END,
       contract     = CASE WHEN asset_mappings.locked THEN asset_mappings.contract
                           ELSE EXCLUDED.contract END,
       decimals     = CASE WHEN asset_mappings.locked THEN asset_mappings.decimals
                           ELSE EXCLUDED.decimals END,
       -- Merge, never replace: each provider contributes the id it knows.
       provider_ids = asset_mappings.provider_ids || EXCLUDED.provider_ids,
       source       = CASE WHEN asset_mappings.locked THEN asset_mappings.source
                           ELSE EXCLUDED.source END,
       resolved_by  = COALESCE(EXCLUDED.resolved_by, asset_mappings.resolved_by),
       last_used_at = now(),
       updated_at   = now()
     RETURNING ${COLUMNS}`,
    [
      normalizeSymbolKey(m.symbol),
      scope,
      m.displayName,
      m.kind ?? 'crypto',
      m.chain ?? null,
      m.contract ?? null,
      m.decimals ?? 8,
      JSON.stringify(m.providerIds),
      m.source,
      m.locked ?? false,
      m.resolvedBy ?? null,
    ],
  );
  return mapRow(rows[0] as Row);
}

/** Records that a mapping was used, for the operator's diagnostics view. */
export async function touchMapping(db: Queryable, id: number): Promise<void> {
  await db.query('UPDATE asset_mappings SET last_used_at = now() WHERE id = $1', [id]);
}

export async function listMappings(db: Queryable, limit = 200): Promise<AssetMapping[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM asset_mappings ORDER BY symbol, scope LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}

/** Deleting a mapping is the supported way to force a fresh resolution. */
export async function deleteMapping(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM asset_mappings WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/** An operator edit. Unlike resolution, this DOES overwrite a locked row. */
export async function updateMapping(
  db: Queryable,
  id: number,
  patch: {
    displayName?: string;
    chain?: string | null;
    contract?: string | null;
    decimals?: number;
    providerIds?: Record<string, string>;
    locked?: boolean;
  },
): Promise<AssetMapping | null> {
  const { rows } = await db.query<Row>(
    `UPDATE asset_mappings SET
       display_name = COALESCE($2, display_name),
       chain        = COALESCE($3, chain),
       contract     = COALESCE($4, contract),
       decimals     = COALESCE($5, decimals),
       provider_ids = COALESCE($6::jsonb, provider_ids),
       locked       = COALESCE($7, locked),
       source       = 'manual',
       updated_at   = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      patch.displayName ?? null,
      patch.chain ?? null,
      patch.contract ?? null,
      patch.decimals ?? null,
      patch.providerIds ? JSON.stringify(patch.providerIds) : null,
      patch.locked ?? null,
    ],
  );
  const r = rows[0];
  return r ? mapRow(r) : null;
}
