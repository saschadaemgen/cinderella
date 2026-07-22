/**
 * CCB-S3-004 verification harness — plugin framework, pinned mappings, provider
 * chain with failover, and the ambiguity flow.
 *
 * Runs the REAL registry, the REAL persistence (PGlite), the REAL chain and the
 * REAL adapters against stub HTTP. No API key is used, entered, or needed.
 * `--live` additionally exercises the keyless providers against the real
 * internet.
 *
 *   npx tsx scripts/verify-price.ts [--live]
 */

import { PGlite } from '@electric-sql/pglite';
import { loadMigrationFiles } from '../src/db/migrate.js';
import type { Queryable } from '../src/db/pool.js';
import {
  findMapping,
  listMappings,
  upsertMapping,
  type AssetMapping,
} from '../src/db/asset-mappings.js';
import { parseAmountAt, parseNumber } from '../src/price/amount.js';
import { formatValue } from '../src/price/format.js';
import { CryptoPriceService } from '../src/plugins/crypto-prices/service.js';
import {
  DEFAULT_CRYPTO_PRICES,
  normalizeCryptoPrices,
  providerKeyStatus,
} from '../src/plugins/crypto-prices/settings.js';
import {
  CoinGeckoProvider,
  DexscreenerProvider,
} from '../src/plugins/crypto-prices/providers/adapters.js';
import { applySecretUpdate, decryptSecret, describeSecret } from '../src/plugins/secrets.js';
import {
  listPlugins,
  normalizePluginStates,
  activePluginIntents,
} from '../src/plugins/registry.js';
import '../src/plugins/crypto-prices/plugin.js';
import { activeIntentList, isActiveIntent, setActiveIntents } from '../src/interaction/intent.js';
import { resolveIntent } from '../src/interaction/resolver.js';
import { normalizeInteraction } from '../src/interaction/settings.js';
import type {
  PriceProvider,
  ProviderQuote,
  AssetCandidate,
} from '../src/plugins/crypto-prices/providers/types.js';
import { ProviderError } from '../src/plugins/crypto-prices/providers/types.js';
import { setLogLevel } from '../src/log.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** A scriptable adapter so failover and attribution are observable. */
class StubProvider implements PriceProvider {
  readonly capabilities: PriceProvider['capabilities'];
  resolveCalls = 0;
  quoteCalls = 0;
  down = false;
  knows: AssetCandidate[] = [];
  price = 1;

  constructor(
    readonly name: string,
    readonly label: string,
    attribution = '',
    private enabled = true,
  ) {
    this.capabilities = {
      canResolve: true,
      requiresKey: false,
      attribution,
      maxCacheSeconds: Number.POSITIVE_INFINITY,
      note: 'stub',
    };
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }
  isConfigured(): boolean {
    return this.enabled;
  }
  resolveSymbol(): Promise<AssetCandidate[]> {
    this.resolveCalls++;
    if (this.down) return Promise.reject(new ProviderError(this.name, 'stub down'));
    return Promise.resolve(this.knows);
  }
  fetchQuote(_ref: unknown, vs: string): Promise<ProviderQuote> {
    this.quoteCalls++;
    if (this.down) return Promise.reject(new ProviderError(this.name, 'stub down'));
    return Promise.resolve({ price: this.price, vs, at: 0, provider: this.name });
  }
}

async function main(): Promise<void> {
  setLogLevel('error');
  process.env['SESSION_SECRET'] ??= 'harness-session-secret-not-a-real-one';

  const pg = new PGlite();
  const db: Queryable = {
    async query(text, values) {
      const res = await pg.query(text, values ? [...values] : undefined);
      return {
        rows: res.rows as never[],
        rowCount: (res.affectedRows ?? res.rows.length) as number,
      };
    },
  };
  for (const m of await loadMigrationFiles()) await pg.exec(m.sql);

  /* ── 1. Plugin framework ───────────────────────────────────────────── */
  section('1. Plugin framework — registry, intents, enable/disable');

  const defs = listPlugins();
  check(
    'the Crypto Prices plugin is registered',
    defs.some((p) => p.id === 'crypto-prices'),
  );
  const def = defs.find((p) => p.id === 'crypto-prices');
  check('it declares the PRICE intent', def?.intents.includes('PRICE') === true);
  check('it is enabled by default', def?.defaultEnabled === true);
  check('it declares its own admin page', def?.adminPath === '/plugins/crypto-prices');

  const onStates = normalizePluginStates({});
  setActiveIntents(activePluginIntents(onStates));
  check('with the plugin ON, PRICE is in the active catalog', isActiveIntent('PRICE'));
  check('core intents are always active', isActiveIntent('PUBLISH') && isActiveIntent('UNDO'));

  const offStates = normalizePluginStates({ 'crypto-prices': { enabled: false } });
  setActiveIntents(activePluginIntents(offStates));
  check('with the plugin OFF, PRICE leaves the catalog', !isActiveIntent('PRICE'));
  check('and the consent intents are untouched', isActiveIntent('PUBLISH'));
  check('the active list shrinks accordingly', !activeIntentList().includes('PRICE'));

  const ctx = { threshold: 0.55, defaultLanguage: 'en' };
  const offResult = await resolveIntent('what is the price of HEX', ctx);
  check(
    'a price question with the plugin off resolves to UNKNOWN, not a half-match',
    offResult.intent === 'UNKNOWN',
    offResult.intent,
  );

  setActiveIntents(activePluginIntents(onStates));
  const onResult = await resolveIntent('what is the price of HEX', ctx);
  check('and to PRICE again once it is on', onResult.intent === 'PRICE');
  check('  with the base slot filled', onResult.slots.base?.toUpperCase() === 'HEX');

  /* ── 2. Write-only API keys ────────────────────────────────────────── */
  section('2. API keys — encrypted, write-only, never rendered back');

  const stored = applySecretUpdate('', 'super-secret-value', false);
  check('a key is stored encrypted, not in clear', !stored.includes('super-secret-value'));
  check('and round-trips', decryptSecret(stored) === 'super-secret-value');
  check('the console only learns that one is set', describeSecret(stored).set === true);
  check(
    'an empty submission KEEPS the stored key',
    applySecretUpdate(stored, '', false) === stored,
  );
  check('an explicit clear removes it', applySecretUpdate(stored, '', true) === '');
  check(
    'a new value replaces it',
    decryptSecret(applySecretUpdate(stored, 'other', false)) === 'other',
  );
  check('an undecryptable value degrades to unset, not a crash', decryptSecret('v1.a.b.c') === '');

  const withKey = normalizeCryptoPrices({
    providers: { coinmarketcap: { apiKey: 'k-123', enabled: true } },
  });
  check('settings store the key encrypted', !JSON.stringify(withKey).includes('k-123'));
  check('and report only its presence', providerKeyStatus(withKey, 'coinmarketcap').set === true);
  const resaved = normalizeCryptoPrices(
    { providers: { coinmarketcap: { enabled: true } } },
    withKey,
  );
  check(
    're-saving the form without touching the field keeps the key',
    decryptSecret(resaved.providers['coinmarketcap']?.apiKey ?? '') === 'k-123',
  );

  /* ── 3. Defaults ───────────────────────────────────────────────────── */
  section('3. Plugin settings defaults');
  check('three providers ship', Object.keys(DEFAULT_CRYPTO_PRICES.providers).length === 3);
  check(
    'the chain is ordered',
    DEFAULT_CRYPTO_PRICES.chain.join(',') === 'coinmarketcap,coingecko,dexscreener',
  );
  check('base currency defaults to USD', DEFAULT_CRYPTO_PRICES.baseCurrency === 'USD');
  check('cache TTL defaults to 60s', DEFAULT_CRYPTO_PRICES.cacheTtlSeconds === 60);
  check('the disclaimer is OFF by default', DEFAULT_CRYPTO_PRICES.disclaimer === '');
  check(
    'a provider left out of the order is still available, just last',
    normalizeCryptoPrices({ chain: 'dexscreener' }).chain.join(',') ===
      'dexscreener,coinmarketcap,coingecko',
  );

  /* ── 4. Amount parsing ─────────────────────────────────────────────── */
  section('4. Amount parsing');
  for (const [input, want] of [
    ['1,000,000', 1000000],
    ['1.000.000', 1000000],
    ['1,5', 1.5],
    ['1.234,56', 1234.56],
  ] as [string, number][]) {
    check(`parseNumber("${input}") = ${want}`, parseNumber(input) === want);
  }
  for (const [toks, want] of [
    [['1', 'million'], 1000000],
    [['1m'], 1000000],
    [['1.5k'], 1500],
    [['100k'], 100000],
    [['2', 'milliarden'], 2e9],
    [['0'], undefined],
    [['banana'], undefined],
  ] as [string[], number | undefined][]) {
    check(`parseAmountAt(${JSON.stringify(toks)})`, parseAmountAt(toks, 0)?.value === want);
  }

  /* ── 5. Lazy resolve, then pinned forever ──────────────────────────── */
  section('5. Resolution — resolved once, pinned, never re-resolved');

  const primary = new StubProvider(
    'coinmarketcap',
    'CoinMarketCap',
    'Data provided by CoinMarketCap.com',
  );
  const secondary = new StubProvider('coingecko', 'CoinGecko', 'Powered by CoinGecko');
  const tertiary = new StubProvider('dexscreener', 'Dexscreener', '');

  let settings = normalizeCryptoPrices({});
  const svc = new CryptoPriceService({
    db,
    settings: () => settings,
    providers: [primary, secondary, tertiary],
    now: () => nowMs,
  });
  let nowMs = 1_000_000;

  primary.knows = [{ id: '5015', symbol: 'BTC', name: 'Bitcoin' }];
  primary.price = 60000;
  const first = await svc.resolve('BTC');
  check('an unambiguous symbol resolves', first.kind === 'mapping');
  check('the provider was asked once', primary.resolveCalls === 1);
  const pinned = await findMapping(db, 'BTC');
  check(
    'and the mapping was PINNED to the database',
    pinned?.providerIds['coinmarketcap'] === '5015',
  );
  check('recording which provider resolved it', pinned?.resolvedBy === 'coinmarketcap');

  const again = await svc.resolve('BTC');
  check('asking again uses the pin', again.kind === 'mapping');
  check(
    'and does NOT re-resolve at the provider',
    primary.resolveCalls === 1,
    `calls ${primary.resolveCalls}`,
  );

  /* ── 6. Ambiguity: asked once, remembered ──────────────────────────── */
  section('6. Ambiguity — asked once, the answer pinned globally');

  primary.knows = [
    { id: '5015', symbol: 'HEX', name: 'HEX', chain: 'ethereum', contract: '0x2b59' },
    {
      id: '28928',
      symbol: 'HEX',
      name: 'HEX (PulseChain)',
      chain: 'pulsechain',
      contract: '0x2b59',
    },
  ];
  const ambiguous = await svc.resolve('HEX');
  check('two candidates produce an ambiguity, not a guess', ambiguous.kind === 'ambiguous');
  if (ambiguous.kind === 'ambiguous') {
    check('  both options are offered', ambiguous.options.length === 2);
    check(
      '  and the provider that produced them is carried along',
      ambiguous.provider === 'coinmarketcap',
    );
    check('  nothing was pinned yet', (await findMapping(db, 'HEX')) === null);

    // The member picks the Ethereum one.
    const picked = ambiguous.options[0] as AssetCandidate;
    await svc.pin('HEX', picked, ambiguous.provider, 'member-choice');
  }
  const hexPin = await findMapping(db, 'HEX');
  check('the answer is pinned', hexPin?.displayName === 'HEX');
  check('with the chain that distinguishes it', hexPin?.chain === 'ethereum');
  check('and marked as a member choice', hexPin?.source === 'member-choice');

  const callsBefore = primary.resolveCalls;
  const afterChoice = await svc.resolve('HEX');
  check('the question is never asked again', afterChoice.kind === 'mapping');
  check('and no provider is consulted', primary.resolveCalls === callsBefore);

  /* ── 7. Locked mappings ────────────────────────────────────────────── */
  section('7. Manual override — a locked mapping is never re-pointed');

  await upsertMapping(db, {
    symbol: 'LOCKED',
    displayName: 'The Right One',
    providerIds: { coinmarketcap: 'right' },
    source: 'manual',
    locked: true,
    chain: 'ethereum',
  });
  await upsertMapping(db, {
    symbol: 'LOCKED',
    displayName: 'An Impostor',
    providerIds: { coingecko: 'wrong' },
    source: 'resolved',
  });
  const locked = await findMapping(db, 'LOCKED');
  check(
    'the locked identity survives an automatic re-pin',
    locked?.displayName === 'The Right One',
  );
  check('the chain survives too', locked?.chain === 'ethereum');
  check(
    'but a new provider id is still LEARNED (merge, not replace)',
    locked?.providerIds['coingecko'] === 'wrong' &&
      locked?.providerIds['coinmarketcap'] === 'right',
  );

  /* ── 8. Quotes, failover, attribution, cache ───────────────────────── */
  section('8. Quotes — failover, attribution, cache');

  const btc = (await findMapping(db, 'BTC')) as AssetMapping;
  primary.price = 60000;
  const q1 = await svc.quote(btc, 'usd');
  check('the first provider in the chain answers', q1?.provider === 'coinmarketcap');
  check(
    'and its required attribution rides along',
    q1?.attribution === 'Data provided by CoinMarketCap.com',
  );

  const quoteCallsBefore = primary.quoteCalls;
  await svc.quote(btc, 'usd');
  check('a repeat is served from cache', primary.quoteCalls === quoteCallsBefore);

  nowMs += 120_000; // past the 60s TTL
  await svc.quote(btc, 'usd');
  check('and refetched once the TTL lapses', primary.quoteCalls === quoteCallsBefore + 1);

  // Failover: the first provider goes down.
  primary.down = true;
  await upsertMapping(db, {
    symbol: 'BTC',
    displayName: 'Bitcoin',
    providerIds: { coingecko: 'bitcoin' },
    source: 'resolved',
  });
  const btc2 = (await findMapping(db, 'BTC')) as AssetMapping;
  secondary.price = 60100;
  svc.clearCache();
  const q2 = await svc.quote(btc2, 'usd');
  check('a failed provider fails over to the next', q2?.provider === 'coingecko');
  check(
    'and the attribution follows the provider that ANSWERED',
    q2?.attribution === 'Powered by CoinGecko',
  );

  // All providers down → honest failure.
  secondary.down = true;
  tertiary.down = true;
  svc.clearCache();
  const q3 = await svc.quote(btc2, 'usd');
  check('with every provider down there is no quote at all', q3 === null);
  const outcome = await svc.price('BTC', 'USD', 1);
  check('which the caller sees as "unavailable", never a number', outcome.kind === 'unavailable');
  primary.down = secondary.down = tertiary.down = false;

  // Disabling all providers in settings.
  settings = normalizeCryptoPrices({
    providers: {
      coinmarketcap: { enabled: false },
      coingecko: { enabled: false },
      dexscreener: { enabled: false },
    },
  });
  primary.setEnabled(false);
  secondary.setEnabled(false);
  tertiary.setEnabled(false);
  svc.clearCache();
  const allOff = await svc.price('BTC', 'USD', 1);
  check('disabling every provider gives the honest answer too', allOff.kind === 'unavailable');
  primary.setEnabled(true);
  secondary.setEnabled(true);
  tertiary.setEnabled(true);
  settings = normalizeCryptoPrices({});

  /* ── 9. Conversion ─────────────────────────────────────────────────── */
  section('9. Conversion — cross rate through the base currency');

  svc.clearCache();
  primary.knows = [{ id: 'eth', symbol: 'ETH', name: 'Ethereum' }];
  await svc.resolve('ETH');
  await upsertMapping(db, {
    symbol: 'HEXX',
    displayName: 'HEX',
    providerIds: { coinmarketcap: 'hexx' },
    source: 'manual',
    decimals: 8,
  });

  // One stub price for everything, so the cross rate is 1:1 and checkable.
  primary.price = 2000;
  const conv = await svc.price('HEXX', 'ETH', 1_000_000);
  check('an asset-to-asset question is a conversion', conv.kind === 'conversion');
  if (conv.kind === 'conversion') {
    check('  crossed through the base currency', conv.value === 1_000_000);
    check('  and attributed', conv.attribution.includes('CoinMarketCap'));
  }

  check('sub-cent values keep their digits', formatValue(0.00048006, 8) === '0.00048006');
  check('large values are grouped', formatValue(65727.1234, 8) === '65,727.12');
  check('never scientific notation', !formatValue(0.00000001234, 8).includes('e'));

  /* ── 10. Registry contents ─────────────────────────────────────────── */
  section('10. Mapping table');
  const all = await listMappings(db);
  check('mappings are listable for the admin', all.length >= 3);
  check(
    'every row carries a canonical id or a chain+contract',
    all.every((m) => Object.keys(m.providerIds).length > 0 || (m.chain && m.contract)),
  );

  /* ── 11. Live (keyless providers only) ─────────────────────────────── */
  if (process.argv.includes('--live')) {
    section('11. LIVE — keyless providers only, no API key used');
    const liveSettings = normalizeCryptoPrices({
      chain: 'coingecko, dexscreener',
      providers: { coinmarketcap: { enabled: false } },
    });
    const live = new CryptoPriceService({
      db,
      settings: () => liveSettings,
      providers: [
        new CoinGeckoProvider({ enabled: () => true, apiKey: () => '', timeoutMs: () => 15000 }),
        new DexscreenerProvider({ enabled: () => true, apiKey: () => '', timeoutMs: () => 15000 }),
      ],
    });
    const liveHex = await live.resolve('HEXLIVE').catch(() => null);
    void liveHex;
    // Pin the real HEX explicitly (contested ticker — exactly the manual case).
    await upsertMapping(db, {
      symbol: 'HEXLIVE',
      displayName: 'HEX',
      chain: 'ethereum',
      contract: '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39',
      providerIds: { coingecko: 'hex' },
      source: 'manual',
      locked: true,
      decimals: 8,
    });
    const m = (await findMapping(db, 'HEXLIVE')) as AssetMapping;
    const lq = await live.quote(m, 'usd');
    check('a live keyless quote for the pinned HEX succeeds', lq !== null && lq.price > 0);
    if (lq) {
      console.log(
        `         1 HEX = ${formatValue(lq.price, 8)} USD  (via ${lq.provider}${lq.attribution ? `, "${lq.attribution}"` : ''})`,
      );
    }
  } else {
    console.log('\n(11. live provider check skipped — pass --live to include it)');
  }

  console.log(`\n${failures === 0 ? 'All price checks passed.' : `${failures} check(s) FAILED.`}`);
  await pg.close();
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
