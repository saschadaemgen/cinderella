-- Pre-pinned major assets (CCB-S3-006 §4, §7e).
--
-- WHY THESE ARE SEEDED RATHER THAN RESOLVED: asking a member whether they meant
-- Bitcoin or "Bitcoin AI" is not a real question. Provider search ranks by
-- liquidity and text match, not legitimacy, so a clone with a bought-up pool can
-- outrank the asset everyone actually means. For the assets where there is no
-- genuine ambiguity, the answer is decided here, once, instead of being put to a
-- member who cannot be expected to know.
--
-- Each is LOCKED, so automatic resolution can never repoint it, and each is
-- registered under BOTH its ticker and its common name — `monero` used to
-- disambiguate into nonsense tokens because only the ticker was known.
--
-- The provider ids are CoinGecko's, verified against the live API at build time
-- (top assets by market capitalisation). Other providers learn their own ids on
-- first use and merge them in; ids are never portable between providers.

INSERT INTO asset_mappings
  (symbol, scope, display_name, kind, chain, contract, decimals, provider_ids, source, locked)
VALUES
  ('BTC',      '*', 'Bitcoin',  'crypto', NULL, NULL, 8, '{"coingecko":"bitcoin"}',     'seed', TRUE),
  ('BITCOIN',  '*', 'Bitcoin',  'crypto', NULL, NULL, 8, '{"coingecko":"bitcoin"}',     'seed', TRUE),
  ('ETH',      '*', 'Ethereum', 'crypto', NULL, NULL, 8, '{"coingecko":"ethereum"}',    'seed', TRUE),
  ('ETHEREUM', '*', 'Ethereum', 'crypto', NULL, NULL, 8, '{"coingecko":"ethereum"}',    'seed', TRUE),
  ('ETHER',    '*', 'Ethereum', 'crypto', NULL, NULL, 8, '{"coingecko":"ethereum"}',    'seed', TRUE),
  ('XMR',      '*', 'Monero',   'crypto', NULL, NULL, 8, '{"coingecko":"monero"}',      'seed', TRUE),
  ('MONERO',   '*', 'Monero',   'crypto', NULL, NULL, 8, '{"coingecko":"monero"}',      'seed', TRUE),
  ('USDT',     '*', 'Tether',   'crypto', NULL, NULL, 6, '{"coingecko":"tether"}',      'seed', TRUE),
  ('TETHER',   '*', 'Tether',   'crypto', NULL, NULL, 6, '{"coingecko":"tether"}',      'seed', TRUE),
  ('USDC',     '*', 'USDC',     'crypto', NULL, NULL, 6, '{"coingecko":"usd-coin"}',    'seed', TRUE),
  ('BNB',      '*', 'BNB',      'crypto', NULL, NULL, 8, '{"coingecko":"binancecoin"}', 'seed', TRUE),
  ('XRP',      '*', 'XRP',      'crypto', NULL, NULL, 6, '{"coingecko":"ripple"}',      'seed', TRUE),
  ('SOL',      '*', 'Solana',   'crypto', NULL, NULL, 8, '{"coingecko":"solana"}',      'seed', TRUE),
  ('SOLANA',   '*', 'Solana',   'crypto', NULL, NULL, 8, '{"coingecko":"solana"}',      'seed', TRUE),
  ('TRX',      '*', 'TRON',     'crypto', NULL, NULL, 6, '{"coingecko":"tron"}',        'seed', TRUE),
  ('DOGE',     '*', 'Dogecoin', 'crypto', NULL, NULL, 8, '{"coingecko":"dogecoin"}',    'seed', TRUE),
  ('DOGECOIN', '*', 'Dogecoin', 'crypto', NULL, NULL, 8, '{"coingecko":"dogecoin"}',    'seed', TRUE),
  ('ADA',      '*', 'Cardano',  'crypto', NULL, NULL, 6, '{"coingecko":"cardano"}',     'seed', TRUE),
  ('CARDANO',  '*', 'Cardano',  'crypto', NULL, NULL, 6, '{"coingecko":"cardano"}',     'seed', TRUE),
  ('ZEC',      '*', 'Zcash',    'crypto', NULL, NULL, 8, '{"coingecko":"zcash"}',       'seed', TRUE),
  ('LTC',      '*', 'Litecoin', 'crypto', NULL, NULL, 8, '{"coingecko":"litecoin"}',    'seed', TRUE),
  ('LITECOIN', '*', 'Litecoin', 'crypto', NULL, NULL, 8, '{"coingecko":"litecoin"}',    'seed', TRUE),
  -- HEX is the contested case this whole design exists for: the Ethereum token,
  -- pinned by contract. PulseChain HEX shares that address on a different chain,
  -- which is why the chain is part of the identity and never a guess.
  ('HEX',      '*', 'HEX',      'crypto', 'ethereum',
   '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39', 8,
   '{"coingecko":"hex"}', 'seed', TRUE)
ON CONFLICT (symbol, scope) DO NOTHING;
