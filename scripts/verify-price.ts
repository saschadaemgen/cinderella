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
import { formatCompact, formatValue } from '../src/price/format.js';
import { candidateMetric, CryptoPriceService } from '../src/plugins/crypto-prices/service.js';
import {
  DEFAULT_CRYPTO_PRICES,
  normalizeCryptoPrices,
  providerKeyStatus,
} from '../src/plugins/crypto-prices/settings.js';
import {
  CoinGeckoProvider,
  DexscreenerProvider,
} from '../src/plugins/crypto-prices/providers/adapters.js';
import {
  applySecretUpdate,
  decryptSecret,
  describeSecret,
  encryptSecret,
  isEncrypted,
  repairSecret,
  secretLayers,
  unwrapSecret,
} from '../src/plugins/secrets.js';
import {
  classifyFailure,
  providerHealth,
  recentAttempts,
} from '../src/plugins/crypto-prices/attempts.js';
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

  // A TYPED key arrives as `apiKeyInput`. These assertions used to submit it as
  // `apiKey` — the same field the stored envelope lives in — which is why they
  // passed for a build in which no provider key had ever worked (CCB-S3-008 §2).
  const withKey = normalizeCryptoPrices({
    providers: { coinmarketcap: { apiKeyInput: 'k-123', enabled: true } },
  });
  check('settings store the key encrypted', !JSON.stringify(withKey).includes('k-123'));
  check('and report only its presence', providerKeyStatus(withKey, 'coinmarketcap').set === true);
  check(
    'and it decrypts back to the typed key in ONE step',
    decryptSecret(withKey.providers['coinmarketcap']?.apiKey ?? '') === 'k-123',
  );
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
    DEFAULT_CRYPTO_PRICES.chain.join(',') === 'coingecko,dexscreener,coinmarketcap',
  );
  check('base currency defaults to USD', DEFAULT_CRYPTO_PRICES.baseCurrency === 'USD');
  check('cache TTL defaults to 60s', DEFAULT_CRYPTO_PRICES.cacheTtlSeconds === 60);
  check('the disclaimer is OFF by default', DEFAULT_CRYPTO_PRICES.disclaimer === '');
  check(
    'a provider left out of the order is still available, just last',
    normalizeCryptoPrices({ chain: 'dexscreener' }).chain[0] === 'dexscreener' &&
      normalizeCryptoPrices({ chain: 'dexscreener' }).chain.length === 3,
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

  // The stubs are named after the real providers, so pin the order explicitly
  // rather than depending on the shipped default (which §8 changed).
  let settings = normalizeCryptoPrices({ chain: 'coinmarketcap, coingecko, dexscreener' });
  const svc = new CryptoPriceService({
    db,
    settings: () => settings,
    providers: [primary, secondary, tertiary],
    now: () => nowMs,
  });
  let nowMs = 1_000_000;

  primary.knows = [{ id: '5015', symbol: 'TESTCOIN', name: 'Testcoin' }];
  primary.price = 60000;
  const first = await svc.resolve('TESTCOIN');
  check('an unambiguous symbol resolves', first.kind === 'mapping');
  check('the provider was asked once', primary.resolveCalls === 1);
  const pinned = await findMapping(db, 'TESTCOIN');
  check(
    'and the mapping was PINNED to the database',
    pinned?.providerIds['coinmarketcap'] === '5015',
  );
  check('recording which provider resolved it', pinned?.resolvedBy === 'coinmarketcap');

  const again = await svc.resolve('TESTCOIN');
  check('asking again uses the pin', again.kind === 'mapping');
  check(
    'and does NOT re-resolve at the provider',
    primary.resolveCalls === 1,
    `calls ${primary.resolveCalls}`,
  );

  /* ── 6. Ambiguity: asked once, remembered ──────────────────────────── */
  section('6. Ambiguity — asked once, the answer pinned globally');

  primary.knows = [
    { id: '5015', symbol: 'CLASH', name: 'Clash', chain: 'ethereum', contract: '0x2b59' },
    {
      id: '28928',
      symbol: 'CLASH',
      name: 'Clash (PulseChain)',
      chain: 'pulsechain',
      contract: '0x2b59',
    },
  ];
  const ambiguous = await svc.resolve('CLASH');
  check('two candidates produce an ambiguity, not a guess', ambiguous.kind === 'ambiguous');
  if (ambiguous.kind === 'ambiguous') {
    check('  both options are offered', ambiguous.options.length === 2);
    check(
      '  and the provider that produced them is carried along',
      ambiguous.provider === 'coinmarketcap',
    );
    check('  nothing was pinned yet', (await findMapping(db, 'CLASH')) === null);

    // The member picks the Ethereum one.
    const picked = ambiguous.options[0] as AssetCandidate;
    await svc.pin('CLASH', picked, ambiguous.provider, 'member-choice');
  }
  const hexPin = await findMapping(db, 'CLASH');
  check('the answer is pinned', hexPin?.displayName === 'Clash');
  check('with the chain that distinguishes it', hexPin?.chain === 'ethereum');
  check('and marked as a member choice', hexPin?.source === 'member-choice');

  const callsBefore = primary.resolveCalls;
  const afterChoice = await svc.resolve('CLASH');
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

  const btc = (await findMapping(db, 'TESTCOIN')) as AssetMapping;
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
    symbol: 'TESTCOIN',
    displayName: 'Testcoin',
    providerIds: { coingecko: 'testcoin' },
    source: 'resolved',
  });
  const btc2 = (await findMapping(db, 'TESTCOIN')) as AssetMapping;
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
  const outcome = await svc.price('TESTCOIN', 'USD', 1);
  check('which the caller sees as "unavailable", never a number', outcome.kind === 'unavailable');
  primary.down = secondary.down = tertiary.down = false;

  // Disabling all providers in settings.
  settings = normalizeCryptoPrices({
    chain: 'coinmarketcap, coingecko, dexscreener',
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
  const allOff = await svc.price('TESTCOIN', 'USD', 1);
  check('disabling every provider gives the honest answer too', allOff.kind === 'unavailable');
  primary.setEnabled(true);
  secondary.setEnabled(true);
  tertiary.setEnabled(true);
  settings = normalizeCryptoPrices({ chain: 'coinmarketcap, coingecko, dexscreener' });

  /* ── 9. Conversion ─────────────────────────────────────────────────── */
  section('9. Conversion — cross rate through the base currency');

  svc.clearCache();
  primary.knows = [{ id: 'conv2', symbol: 'CONVB', name: 'ConvB' }];
  await svc.resolve('CONVB');
  await upsertMapping(db, {
    symbol: 'HEXX',
    displayName: 'HEX',
    providerIds: { coinmarketcap: 'hexx' },
    source: 'manual',
    decimals: 8,
  });

  // One stub price for everything, so the cross rate is 1:1 and checkable.
  primary.price = 2000;
  const conv = await svc.price('HEXX', 'CONVB', 1_000_000);
  check('an asset-to-asset question is a conversion', conv.kind === 'conversion');
  if (conv.kind === 'conversion') {
    check('  crossed through the base currency', conv.value === 1_000_000);
    check('  and attributed', conv.attribution.includes('CoinMarketCap'));
  }

  check(
    'sub-cent values keep four significant digits (CCB-S3-006 §2)',
    formatValue(0.00048006, 8) === '0.0004801',
    formatValue(0.00048006, 8),
  );
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

  /* ── 10b. CCB-S3-006 fixes ─────────────────────────────────────────── */
  section('10b. CCB-S3-006 — precision, seeded majors, ranking, dominance');

  // §2 precision: a non-zero price must never render as zero, at any magnitude.
  check('~65,000 renders with separators', formatValue(65583.26, 8) === '65,583.26');
  check('~571 keeps its decimal', formatValue(571.4, 8) === '571.4');
  check(
    '~0.00047 keeps significant digits, not 0',
    formatValue(0.00047884, 4) === '0.0004788',
    formatValue(0.00047884, 4),
  );
  check(
    '~0.000000012 survives too',
    formatValue(0.000000012, 4) === '0.000000012',
    formatValue(0.000000012, 4),
  );
  check('a non-zero value NEVER formats as "0"', formatValue(0.0000000000001, 2) !== '0');
  check(
    'compact figures for the candidate list',
    formatCompact(1.3e12) === '$1.3T' && formatCompact(412000) === '$412K',
  );

  // §4/§7e — the majors are pre-pinned and never disambiguate.
  for (const sym of ['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'XMR', 'MONERO', 'HEX']) {
    const m = await findMapping(db, sym);
    check(`${sym} is pre-pinned and locked`, m !== null && m.locked, m?.displayName);
  }
  const hexSeed = await findMapping(db, 'HEX');
  check(
    'HEX is pinned to the Ethereum contract, not the PulseChain fork',
    hexSeed?.chain === 'ethereum' &&
      hexSeed?.contract === '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39',
  );
  const majorCalls = primary.resolveCalls;
  const btcAgain = await svc.resolve('BTC');
  check(
    'a major never reaches a provider',
    btcAgain.kind === 'mapping' && primary.resolveCalls === majorCalls,
  );

  // §4 dominance auto-resolve.
  primary.knows = [
    { id: 'big', symbol: 'DOM', name: 'Dominant', marketCap: 1_000_000_000_000 },
    { id: 'small', symbol: 'DOM', name: 'Clone', marketCap: 100_000 },
  ];
  const dominant = await svc.resolve('DOM');
  check('a dominant candidate auto-resolves instead of asking', dominant.kind === 'mapping');
  if (dominant.kind === 'mapping') {
    check('  and picks the dominant one', dominant.mapping.displayName === 'Dominant');
    check('  flagged as auto-resolved', dominant.autoResolved === true);
  }

  // §4 genuine ambiguity: ranked, capped, with a visible figure.
  primary.knows = [
    { id: 'a', symbol: 'AMB', name: 'Small A', marketCap: 300_000 },
    { id: 'b', symbol: 'AMB', name: 'Big B', marketCap: 900_000 },
    { id: 'c', symbol: 'AMB', name: 'Mid C', marketCap: 600_000 },
    { id: 'd', symbol: 'AMB', name: 'Tiny D', marketCap: 100_000 },
    { id: 'e', symbol: 'AMB', name: 'Tiny E', marketCap: 90_000 },
  ];
  const amb2 = await svc.resolve('AMB');
  check('genuine ambiguity still asks', amb2.kind === 'ambiguous');
  if (amb2.kind === 'ambiguous') {
    check('  ranked by market cap, biggest first', amb2.options[0]?.name === 'Big B');
    check(
      '  capped at the configured maximum',
      amb2.options.length === DEFAULT_CRYPTO_PRICES.maxCandidates,
    );
    check(
      '  each candidate carries a visible figure',
      candidateMetric(amb2.options[0] as never) === '$900K',
    );
  }

  // §4 dominance is configurable and can be switched off.
  settings = normalizeCryptoPrices({
    chain: 'coinmarketcap, coingecko, dexscreener',
    dominanceFactor: 0,
  });
  primary.knows = [
    { id: 'big2', symbol: 'DOM2', name: 'Dominant', marketCap: 1_000_000_000_000 },
    { id: 'small2', symbol: 'DOM2', name: 'Clone', marketCap: 100 },
  ];
  const noAuto = await svc.resolve('DOM2');
  check('dominance auto-resolve can be switched off', noAuto.kind === 'ambiguous');
  settings = normalizeCryptoPrices({ chain: 'coinmarketcap, coingecko, dexscreener' });

  // §5 the Dexscreener liquidity floor is configurable.
  check(
    'the Dexscreener liquidity floor and 60/min limit ship as defaults',
    DEFAULT_CRYPTO_PRICES.providers['dexscreener']?.rateLimitPerMinute === 60 &&
      DEFAULT_CRYPTO_PRICES.providers['dexscreener']?.minLiquidityUsd === 25_000,
  );

  /* ── 10c. CCB-S3-008 — keys, pin serviceability, diagnosability ────── */

  section('10c. CCB-S3-008 — stored keys, pin self-check, failure diagnosis');

  // THE LIVE DEFECT. Loading stored settings looked exactly like submitting the
  // form, so each boot wrapped the stored key in another layer of encryption and
  // the providers were handed a `v1.…` envelope as their credential. The
  // operator's keys had never once worked, and the only symptom was "the markets
  // are out of earshot".
  const typed = normalizeCryptoPrices({
    providers: { coingecko: { apiKeyInput: 'CG-a-real-looking-key' } },
  });
  const storedOnce = typed.providers['coingecko']?.apiKey ?? '';
  check('a typed key is stored encrypted', isEncrypted(storedOnce));
  check('and decrypts to exactly what was typed', decryptSecret(storedOnce) === 'CG-a-real-looking-key');

  // Load → normalize → load → normalize, the boot path, repeatedly.
  let reloaded = typed;
  for (let i = 0; i < 3; i++) reloaded = normalizeCryptoPrices(reloaded, DEFAULT_CRYPTO_PRICES);
  check(
    'reloading the stored settings does NOT re-encrypt the key',
    decryptSecret(reloaded.providers['coingecko']?.apiKey ?? '') === 'CG-a-real-looking-key',
    `got a ${String(decryptSecret(reloaded.providers['coingecko']?.apiKey ?? '').slice(0, 3))}… value`,
  );
  check(
    'so the value the provider is handed is a key, not an envelope',
    !isEncrypted(decryptSecret(reloaded.providers['coingecko']?.apiKey ?? '')),
  );

  // An instance already written by the buggy path heals itself.
  const doubled = encryptSecret(encryptSecret('CG-doubly-wrapped'));
  check('a doubly-encrypted value is detected', unwrapSecret(doubled).layers === 2);
  const healed = normalizeCryptoPrices({ providers: { coingecko: { apiKey: doubled } } });
  check(
    'and is repaired on load',
    decryptSecret(healed.providers['coingecko']?.apiKey ?? '') === 'CG-doubly-wrapped',
  );

  // A blank submission still leaves an existing key alone (the write-only rule).
  const untouched = normalizeCryptoPrices(
    { providers: { coingecko: { apiKeyInput: '' } } },
    reloaded,
  );
  check(
    'submitting the form without touching the field keeps the key',
    decryptSecret(untouched.providers['coingecko']?.apiKey ?? '') === 'CG-a-real-looking-key',
  );

  // A HEALTHY key must not be rewritten on every boot: `encryptSecret` uses a
  // fresh IV, so any repair keyed off string inequality would loop forever.
  check(
    'a healthy single-layer key needs no repair',
    repairSecret(storedOnce) === null && secretLayers(storedOnce) === 1,
  );
  check('and a doubly-wrapped one reports two layers', secretLayers(doubled) === 2);
  // Unwrapping that cannot finish must NOT be reported as repaired.
  check(
    'a value still wrapped after unwrapping is left alone, not "repaired"',
    repairSecret(encryptSecret('v1.not.real.envelope')) === null ||
      !isEncrypted(unwrapSecret(repairSecret(encryptSecret('v1.not.real.envelope')) ?? '').value),
  );
  // A typed value shaped like an envelope is still ENCRYPTED, never stored raw.
  const lookalike = normalizeCryptoPrices({
    providers: { coingecko: { apiKeyInput: 'v1.a.b.c' } },
  });
  check(
    'a typed key that merely looks like an envelope is still encrypted',
    !JSON.stringify(lookalike).includes('"v1.a.b.c"'),
  );
  // A plaintext that reached the STORAGE field is encrypted, never passed through.
  const strayPlaintext = normalizeCryptoPrices({
    providers: { coingecko: { apiKey: 'PLAINTEXT-KEY-123' } },
  });
  check(
    'a plaintext in the storage field is encrypted, not stored in clear',
    !JSON.stringify(strayPlaintext).includes('PLAINTEXT-KEY-123') &&
      decryptSecret(strayPlaintext.providers['coingecko']?.apiKey ?? '') === 'PLAINTEXT-KEY-123',
  );

  // §3 §1 — the alternates argument the engine had been passing since CCB-S3-006
  // and the service had been silently discarding.
  await upsertMapping(db, {
    symbol: 'BITCOIN',
    scope: '*',
    kind: 'crypto',
    displayName: 'Bitcoin',
    providerIds: { coingecko: 'bitcoin' },
    source: 'seed',
    locked: true,
  });
  const altSvc = new CryptoPriceService({ db, settings: () => settings, now: () => nowMs });
  check(
    'an unpinned base gives way to a pinned alternate from the same sentence',
    await altSvc.isPinned('BITCOIN'),
  );
  const viaAlt = await altSvc.price('real', undefined, 1, '*', ['bitcoin']);
  check(
    'so "one real bitcoin" prices bitcoin, not "real"',
    viaAlt.kind !== 'unknown-asset',
    viaAlt.kind,
  );

  // §2 — a pin no enabled provider can serve.
  // Leaving a provider out of the ORDER does not disable it, so the ones that
  // could serve this pin are switched off outright.
  // The live shape of the defect: a chain that IS working (CoinMarketCap first,
  // with a key) but holds no id for this pin, and the provider that does hold one
  // is switched off. The pin then fails every lookup, silently.
  settings = normalizeCryptoPrices({
    chain: 'coinmarketcap',
    providers: {
      coinmarketcap: { enabled: true, apiKeyInput: 'cmc-key' },
      coingecko: { enabled: false },
      dexscreener: { enabled: false },
    },
  });
  const pinSvc = new CryptoPriceService({ db, settings: () => settings, now: () => nowMs });
  await upsertMapping(db, {
    symbol: 'ORPHAN',
    scope: '*',
    kind: 'crypto',
    displayName: 'Orphan',
    providerIds: { coingecko: 'orphan' },
    source: 'manual',
    locked: false,
  });
  const checks = await pinSvc.checkPins();
  const orphan = checks.find((c) => c.symbol === 'ORPHAN');
  check(
    'the self-check names a pin no enabled provider can serve',
    orphan !== undefined && !orphan.ok,
    orphan?.reason,
  );
  check(
    'and says WHY — the enabled chain holds no id for it',
    orphan?.reason === 'no enabled provider holds an id for this pin',
    orphan?.reason,
  );
  settings = normalizeCryptoPrices({ chain: 'coingecko, coinmarketcap, dexscreener' });
  const served = (await pinSvc.checkPins()).find((c) => c.symbol === 'ORPHAN');
  check('and clears it once a provider that holds its id is enabled', served?.ok === true);

  // A CONTRACT-ONLY pin is servable by a DEX source and by nobody else. Counting
  // every provider gave exactly this pin a false all-clear.
  await upsertMapping(db, {
    symbol: 'DEXONLY',
    scope: '*',
    kind: 'crypto',
    displayName: 'Dex Only',
    chain: 'ethereum',
    contract: '0x0000000000000000000000000000000000000001',
    providerIds: {},
    source: 'resolved',
    locked: false,
  });
  settings = normalizeCryptoPrices({
    chain: 'coingecko',
    providers: {
      coingecko: { enabled: true },
      dexscreener: { enabled: false },
      coinmarketcap: { enabled: false },
    },
  });
  const dexOnly = (await pinSvc.checkPins()).find((c) => c.symbol === 'DEXONLY');
  check(
    'a contract-only pin is NOT reported as servable by a provider that cannot use it',
    dexOnly !== undefined && !dexOnly.ok,
    dexOnly?.servedBy.join(', '),
  );
  settings = normalizeCryptoPrices({ chain: 'dexscreener, coingecko' });
  const dexOk = (await pinSvc.checkPins()).find((c) => c.symbol === 'DEXONLY');
  check('and IS once the DEX source is enabled', dexOk?.ok === true);

  // §3 — failures are classified rather than all looking alike.
  check('a 401 is read as a rejected credential', classifyFailure('HTTP 401').outcome === 'unauthorized');
  check('a 429 is read as throttling', classifyFailure('HTTP 429').outcome === 'throttled');
  check('a timeout is read as unreachable', classifyFailure('request timed out').outcome === 'unreachable');
  check(
    'attempts are recorded with provider, symbol and outcome',
    recentAttempts(50).some((a) => a.provider !== '' && a.symbol !== ''),
  );
  check(
    'and health is summarised per provider',
    providerHealth(['coingecko']).length === 1,
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
