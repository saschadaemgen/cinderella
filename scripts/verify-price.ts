/**
 * CCB-S3-004 verification harness — price lookup and conversion.
 *
 * Runs the REAL resolver, registry, cache and conversion maths. The provider is
 * a stub by default so the harness is deterministic and offline; pass `--live`
 * to run the same checks against the real provider as well.
 *
 *   npx tsx scripts/verify-price.ts [--live]
 */

import { DEFAULT_ASSETS, formatValue, lookupAsset, normalizeSymbol } from '../src/price/assets.js';
import { parseAmountAt, parseNumber } from '../src/price/amount.js';
import { CoinGeckoProvider, type PriceProvider, type Quote } from '../src/price/provider.js';
import { PriceService } from '../src/price/service.js';
import { resolveIntent } from '../src/interaction/resolver.js';
import { normalizeInteraction } from '../src/interaction/settings.js';
import { setLogLevel } from '../src/log.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** Fixed prices so the maths is checkable by hand. */
const STUB_PRICES: Record<string, number> = { hex: 0.0005, ethereum: 2000, bitcoin: 60000 };

class StubProvider implements PriceProvider {
  readonly name = 'stub';
  calls = 0;
  fail = false;
  lastIds: string[] = [];

  fetchPrices(ids: string[], vs: string): Promise<Quote[]> {
    this.calls++;
    this.lastIds = ids;
    if (this.fail) return Promise.reject(new Error('simulated outage'));
    return Promise.resolve(
      ids
        .filter((id) => id in STUB_PRICES)
        .map((id) => ({ id, vs, price: STUB_PRICES[id] as number, at: Date.now() })),
    );
  }
}

async function main(): Promise<void> {
  setLogLevel('error');
  const settings = normalizeInteraction({});
  const ctx = { threshold: settings.confidenceThreshold, defaultLanguage: 'en' };

  /* ── 1. Registry pinning ───────────────────────────────────────────── */
  section('1. Asset registry — pinned ids, not symbol guesses');

  const hex = DEFAULT_ASSETS.find((a) => a.symbol === 'HEX');
  check('HEX ships in the registry', hex !== undefined);
  check('HEX is pinned to the canonical provider id "hex"', hex?.id === 'hex');
  check(
    'HEX records the Ethereum contract that identifies WHICH hex',
    hex?.chain === 'ethereum' && hex?.contract === '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39',
    hex?.contract,
  );
  check(
    'the majors and both fiats ship too',
    ['BTC', 'ETH', 'USD', 'EUR'].every((s) => DEFAULT_ASSETS.some((a) => a.symbol === s)),
  );
  check(
    'aliases resolve ("ether", "euro", "dollar")',
    lookupAsset(DEFAULT_ASSETS, 'ether').asset?.id === 'ethereum' &&
      lookupAsset(DEFAULT_ASSETS, 'Euro').asset?.id === 'eur' &&
      lookupAsset(DEFAULT_ASSETS, 'US Dollar').asset?.id === 'usd',
  );
  check(
    'an unknown symbol resolves to nothing',
    lookupAsset(DEFAULT_ASSETS, 'WAGMI').asset === undefined,
  );

  const collided = [
    ...DEFAULT_ASSETS,
    {
      symbol: 'HEX',
      id: 'hex-pulsechain',
      name: 'HEX (PulseChain)',
      kind: 'crypto' as const,
      decimals: 8,
      aliases: [],
    },
  ];
  const amb = lookupAsset(collided, 'HEX');
  check(
    'a symbol claimed by two entries is reported AMBIGUOUS, not guessed',
    amb.ambiguous?.length === 2,
  );
  check(
    'and the ambiguity names both canonical ids',
    amb.ambiguous?.map((a) => a.id).join(',') === 'hex,hex-pulsechain',
  );

  /* ── 2. Amount parsing ─────────────────────────────────────────────── */
  section('2. Amount parsing — unit words and both separator conventions');

  const cases: [string, number | undefined][] = [
    ['1000000', 1000000],
    ['1,000,000', 1000000],
    ['1.000.000', 1000000],
    ['1.5', 1.5],
    ['1,5', 1.5],
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
  ];
  for (const [input, want] of cases) {
    check(`parseNumber("${input}") = ${String(want)}`, parseNumber(input) === want);
  }

  const amounts: [string[], number | undefined][] = [
    [['1', 'million'], 1000000],
    [['1m'], 1000000],
    [['1.5k'], 1500],
    [['100k'], 100000],
    [['1', 'Million'], 1000000],
    [['2', 'milliarden'], 2e9],
    [['1e30'], undefined],
    [['0'], undefined],
    [['banana'], undefined],
  ];
  for (const [toks, want] of amounts) {
    const got = parseAmountAt(
      toks.map((t) => t.toLowerCase()),
      0,
    )?.value;
    check(`parseAmountAt(${JSON.stringify(toks)}) = ${String(want)}`, got === want, String(got));
  }
  check(
    'an absurd amount is rejected rather than answered',
    parseAmountAt(['999999999999999999'], 0) === undefined,
  );

  /* ── 3. Intent + slots ─────────────────────────────────────────────── */
  section('3. PRICE intent and slot extraction');

  const r = async (t: string): Promise<Awaited<ReturnType<typeof resolveIntent>>> =>
    resolveIntent(t, ctx);

  const q1 = await r('what is the current US dollar value of HEX?');
  check('"what is the current US dollar value of HEX?" → PRICE', q1.intent === 'PRICE');
  check('  base = HEX', q1.slots.base?.toUpperCase() === 'HEX', q1.slots.base);

  const q2 = await r('how much Ethereum do I get for 1 million HEX?');
  check('"how much Ethereum do I get for 1 million HEX?" → PRICE', q2.intent === 'PRICE');
  check('  base = HEX (what they pay)', q2.slots.base?.toUpperCase() === 'HEX', q2.slots.base);
  check(
    '  quote = Ethereum (what they receive)',
    /eth/i.test(q2.slots.quote ?? ''),
    q2.slots.quote,
  );
  check('  amount = 1000000', q2.slots.amount === 1000000, String(q2.slots.amount));

  const q3 = await r('price of BTC in EUR');
  check('"price of BTC in EUR" → PRICE', q3.intent === 'PRICE');
  check('  base = BTC', q3.slots.base?.toUpperCase() === 'BTC', q3.slots.base);
  check('  quote = EUR', q3.slots.quote?.toUpperCase() === 'EUR', q3.slots.quote);

  const q4 = await r('was ist ein HEX in Euro wert?');
  check('"was ist ein HEX in Euro wert?" → PRICE', q4.intent === 'PRICE');
  check('  base = HEX', q4.slots.base?.toUpperCase() === 'HEX', q4.slots.base);
  check('  quote = Euro', /euro/i.test(q4.slots.quote ?? ''), q4.slots.quote);
  check('  answers in German', q4.lang === 'de');

  check(
    'PRICE never displaces the consent intents',
    (await r('publish me')).intent === 'PUBLISH' &&
      (await r('unpublish me')).intent === 'UNPUBLISH' &&
      (await r('what do you have on me')).intent === 'STATUS',
  );

  /* ── 4. Lookup, conversion, cache, failure ─────────────────────────── */
  section('4. Quotes, cross-rate conversion, cache and failure');

  const stub = new StubProvider();
  const svc = new PriceService({
    provider: stub,
    registry: () => DEFAULT_ASSETS,
    baseCurrency: () => 'USD',
    cacheTtlMs: () => 60_000,
  });

  const direct = await svc.price('HEX', 'USD', 1);
  check('a direct HEX/USD price is returned', direct.kind === 'price');
  if (direct.kind === 'price') {
    check('  value = 1 x 0.0005', direct.value === 0.0005, String(direct.value));
    check('  the provider was queried by canonical id, not symbol', stub.lastIds.join() === 'hex');
    check('  rendered with sub-cent precision', PriceService.render(direct).value === '0.0005');
  }

  const million = await svc.price('HEX', 'ETH', 1_000_000);
  check('a HEX→ETH conversion is a cross rate', million.kind === 'conversion');
  if (million.kind === 'conversion') {
    // 1e6 * 0.0005 = 500 USD; 500 / 2000 = 0.25 ETH
    check('  1,000,000 HEX = 0.25 ETH via USD', million.value === 0.25, String(million.value));
    const rendered = PriceService.render(million);
    check('  amount is rendered readably', rendered.amount === '1,000,000', rendered.amount);
    check('  value is rendered readably', rendered.value === '0.25', rendered.value);
  }

  const callsBefore = stub.calls;
  await svc.price('HEX', 'USD', 1);
  await svc.price('HEX', 'USD', 5);
  await svc.price('HEX', 'USD', 9);
  check(
    'repeated questions are served from cache',
    stub.calls === callsBefore,
    `calls ${stub.calls}`,
  );

  const unknown = await svc.price('WAGMI', 'USD', 1);
  check('an unknown asset is reported, never guessed', unknown.kind === 'unknown-asset');

  const ambiguousSvc = new PriceService({
    provider: stub,
    registry: () => collided,
    baseCurrency: () => 'USD',
    cacheTtlMs: () => 60_000,
  });
  const ambiguous = await ambiguousSvc.price('HEX', 'USD', 1);
  check('an ambiguous symbol asks instead of choosing', ambiguous.kind === 'ambiguous');

  stub.fail = true;
  svc.clearCache();
  const down = await svc.price('HEX', 'USD', 1);
  check('a provider outage answers honestly', down.kind === 'unavailable');
  check('and never yields a number', !('value' in down));
  stub.fail = false;

  const partial = new PriceService({
    provider: {
      name: 'partial',
      fetchPrices: (ids, vs) =>
        Promise.resolve(
          ids.filter((i) => i === 'hex').map((i) => ({ id: i, vs, price: 0.0005, at: Date.now() })),
        ),
    },
    registry: () => DEFAULT_ASSETS,
    baseCurrency: () => 'USD',
    cacheTtlMs: () => 60_000,
  });
  const half = await partial.price('HEX', 'ETH', 1);
  check(
    'a provider that answers for only one leg is a failure, not a zero',
    half.kind === 'unavailable',
  );

  /* ── 5. Formatting ─────────────────────────────────────────────────── */
  section('5. Readable numbers');
  check('sub-cent values keep their digits', formatValue(0.00048006, 8) === '0.00048006');
  check('large values are grouped and rounded', formatValue(65727.1234, 8) === '65,727.12');
  check('mid-range values stay sensible', formatValue(0.2501094, 8) === '0.250109');
  check('a value is never scientific notation', !formatValue(0.00000001234, 8).includes('e'));
  check('symbol normalisation folds case and punctuation', normalizeSymbol(' Hex! ') === 'hex');

  /* ── 6. Optional live provider check ───────────────────────────────── */
  if (process.argv.includes('--live')) {
    section('6. LIVE provider');
    const live = new PriceService({
      provider: new CoinGeckoProvider({ timeoutMs: 15000 }),
      registry: () => DEFAULT_ASSETS,
      baseCurrency: () => 'USD',
      cacheTtlMs: () => 60_000,
    });
    const liveHex = await live.price('HEX', 'USD', 1);
    check('live HEX/USD returns a positive price', liveHex.kind === 'price' && liveHex.value > 0);
    if (liveHex.kind === 'price')
      console.log(`         1 HEX = ${PriceService.render(liveHex).value} USD`);
    const liveConv = await live.price('HEX', 'ETH', 1_000_000);
    check(
      'live HEX→ETH conversion returns a positive value',
      liveConv.kind === 'conversion' && liveConv.value > 0,
    );
    if (liveConv.kind === 'conversion') {
      const rr = PriceService.render(liveConv);
      console.log(`         ${rr.amount} HEX = ${rr.value} ETH`);
    }
  } else {
    console.log('\n(6. live provider check skipped — pass --live to include it)');
  }

  console.log(`\n${failures === 0 ? 'All price checks passed.' : `${failures} check(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
