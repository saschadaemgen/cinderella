-- Persistent symbol → asset mappings (CCB-S3-004).
--
-- THE POINT OF THIS TABLE: provider search rankings shift over time. Resolving a
-- ticker on every request means the same question can quietly return a different
-- token's price on a later day, and nobody would notice until someone acted on
-- it. So a symbol is resolved ONCE — automatically when it is unambiguous, or by
-- asking the member when it is not — and then PINNED here until an operator
-- changes it. Never silently re-resolved.
--
-- The row identifies an ASSET, not a provider record: the display name, chain and
-- contract are the durable identity, and `provider_ids` carries the id each
-- provider happens to use for it. That is what lets the provider chain fail over
-- from one source to another and still be talking about the same token.
--
-- Deleting a row is the supported way to force a fresh resolution.

CREATE TABLE asset_mappings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Uppercased ticker as members type it.
  symbol        TEXT        NOT NULL,
  -- '*' = global, which is the default and what nearly everything uses: HEX is
  -- HEX regardless of which group asks. A SimpleX group id here overrides that
  -- for one community, for genuine exceptions only.
  scope         TEXT        NOT NULL DEFAULT '*',
  display_name  TEXT        NOT NULL,
  kind          TEXT        NOT NULL DEFAULT 'crypto' CHECK (kind IN ('crypto', 'fiat')),
  -- Durable identity of a token, and the evidence for which asset this is.
  chain         TEXT,
  contract      TEXT,
  -- Display precision when a value is expressed in this asset.
  decimals      INTEGER     NOT NULL DEFAULT 8,
  -- { "coingecko": "hex", "coinmarketcap": "5015", "dexscreener": "0x2b59..." }
  provider_ids  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- How this mapping came to exist:
  --   seed          shipped with the product
  --   manual        an operator typed it
  --   resolved      exactly one provider match, pinned automatically
  --   member-choice a member disambiguated it and the answer was kept
  source        TEXT        NOT NULL DEFAULT 'resolved'
                  CHECK (source IN ('seed', 'manual', 'resolved', 'member-choice')),
  -- Locked mappings are never touched by automatic resolution. Used for the
  -- known-contested tickers where an automatic answer is a coin flip.
  locked        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Diagnostics: which provider produced this, and when it was last used.
  resolved_by   TEXT,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (symbol, scope)
);

CREATE INDEX asset_mappings_symbol_idx ON asset_mappings (symbol);
