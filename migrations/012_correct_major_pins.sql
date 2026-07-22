-- Correct pins that predate the seeded majors (CCB-S3-006 §4, §7e).
--
-- WHY THIS EXISTS: migration 011 used ON CONFLICT DO NOTHING, which was too
-- cautious. On the live instance members had already answered disambiguation
-- questions, and those answers were exactly the mis-resolutions §4 was written
-- to eliminate:
--
--   HEX  ->  "HEX (PulseChain)"    -- the forked chain's token, not the one asked about
--   BTC  ->  CoinMarketCap id only -- unreachable once CMC moved last and keyless
--
-- The PulseChain pin is the serious one: it is a different asset at a different
-- price, answering to the same ticker, which is the entire failure mode the
-- pinning design exists to prevent.
--
-- So a seeded symbol is now CORRECTED rather than skipped. Provider ids are
-- REPLACED, not merged, because a merge would preserve the wrong CoinMarketCap
-- id for HEX and keep pointing one provider at the other chain's token. Other
-- providers re-learn their own ids on first use.
--
-- An operator's own edit is never touched: rows with source = 'manual' are
-- excluded, because a deliberate human decision outranks a shipped default.

UPDATE asset_mappings AS m
SET display_name = s.display_name,
    kind         = 'crypto',
    chain        = s.chain,
    contract     = s.contract,
    decimals     = s.decimals,
    provider_ids = s.provider_ids,
    source       = 'seed',
    locked       = TRUE,
    updated_at   = now()
FROM (VALUES
  ('BTC',      'Bitcoin',  NULL::text, NULL::text, 8, '{"coingecko":"bitcoin"}'::jsonb),
  ('BITCOIN',  'Bitcoin',  NULL,       NULL,       8, '{"coingecko":"bitcoin"}'::jsonb),
  ('ETH',      'Ethereum', NULL,       NULL,       8, '{"coingecko":"ethereum"}'::jsonb),
  ('ETHEREUM', 'Ethereum', NULL,       NULL,       8, '{"coingecko":"ethereum"}'::jsonb),
  ('ETHER',    'Ethereum', NULL,       NULL,       8, '{"coingecko":"ethereum"}'::jsonb),
  ('XMR',      'Monero',   NULL,       NULL,       8, '{"coingecko":"monero"}'::jsonb),
  ('MONERO',   'Monero',   NULL,       NULL,       8, '{"coingecko":"monero"}'::jsonb),
  ('USDT',     'Tether',   NULL,       NULL,       6, '{"coingecko":"tether"}'::jsonb),
  ('TETHER',   'Tether',   NULL,       NULL,       6, '{"coingecko":"tether"}'::jsonb),
  ('USDC',     'USDC',     NULL,       NULL,       6, '{"coingecko":"usd-coin"}'::jsonb),
  ('BNB',      'BNB',      NULL,       NULL,       8, '{"coingecko":"binancecoin"}'::jsonb),
  ('XRP',      'XRP',      NULL,       NULL,       6, '{"coingecko":"ripple"}'::jsonb),
  ('SOL',      'Solana',   NULL,       NULL,       8, '{"coingecko":"solana"}'::jsonb),
  ('SOLANA',   'Solana',   NULL,       NULL,       8, '{"coingecko":"solana"}'::jsonb),
  ('TRX',      'TRON',     NULL,       NULL,       6, '{"coingecko":"tron"}'::jsonb),
  ('DOGE',     'Dogecoin', NULL,       NULL,       8, '{"coingecko":"dogecoin"}'::jsonb),
  ('DOGECOIN', 'Dogecoin', NULL,       NULL,       8, '{"coingecko":"dogecoin"}'::jsonb),
  ('ADA',      'Cardano',  NULL,       NULL,       6, '{"coingecko":"cardano"}'::jsonb),
  ('CARDANO',  'Cardano',  NULL,       NULL,       6, '{"coingecko":"cardano"}'::jsonb),
  ('ZEC',      'Zcash',    NULL,       NULL,       8, '{"coingecko":"zcash"}'::jsonb),
  ('LTC',      'Litecoin', NULL,       NULL,       8, '{"coingecko":"litecoin"}'::jsonb),
  ('LITECOIN', 'Litecoin', NULL,       NULL,       8, '{"coingecko":"litecoin"}'::jsonb),
  ('HEX',      'HEX',      'ethereum', '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39', 8,
                                                      '{"coingecko":"hex"}'::jsonb)
) AS s(symbol, display_name, chain, contract, decimals, provider_ids)
WHERE m.symbol = s.symbol
  AND m.scope = '*'
  AND m.source <> 'manual';
