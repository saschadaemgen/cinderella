/**
 * CCB-S3-002 verification harness — natural addressing, the intent resolver,
 * the confirmation flow, and Cinderella's voice.
 *
 * Runs the REAL code against real Postgres (PGlite in WASM, no server): the real
 * addressing model, the real rule resolver, the real dialogue engine, and the
 * real consent write path with the real publish views behind it. The only fakes
 * are the clock, the randomness, and the outbound SimpleX send — everything the
 * briefing's acceptance criteria are about is genuine.
 *
 *   npx tsx scripts/verify-interaction.ts
 */

import { PGlite } from '@electric-sql/pglite';
import type { T } from '@simplex-chat/types';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { upsertMessage } from '../src/db/messages.js';
import { getConsent } from '../src/db/consent.js';
import { memberConsentHistory } from '../src/db/consent-actions.js';
import { applyConsentChange } from '../src/consent/apply.js';
import { parseConsentCommand } from '../src/consent/commands.js';
import { registerCapture, type CaptureHooks } from '../src/capture/handler.js';
import type { CapturedMessage } from '../src/capture/message.js';
import type { Config } from '../src/config.js';
import type { BotHandle } from '../src/bot/client.js';
import type { Queryable } from '../src/db/pool.js';
import { InteractionEngine } from '../src/interaction/engine.js';
import { missingHelpPlaceholders } from '../src/interaction/help.js';
import { setActiveIntents } from '../src/interaction/intent.js';
import { detectAddress } from '../src/interaction/addressing.js';
import {
  resolveIntent,
  resetIntentResolver,
  setIntentResolver,
} from '../src/interaction/resolver.js';
import {
  DEFAULT_INTERACTION,
  normalizeInteraction,
  type InteractionSettings,
} from '../src/interaction/settings.js';
import { formatOutbound, sanitizeDisplayName } from '../src/interaction/reply.js';
import { clearNearMisses, recentNearMisses } from '../src/interaction/near-misses.js';
import { detectLanguage } from '../src/interaction/text.js';
import { setLogLevel } from '../src/log.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

const GROUP = 1;
const ALICE = 'member-alice';
const BOB = 'member-bob';

/* ── Fakes ───────────────────────────────────────────────────────────────── */

let nowMs = Date.parse('2026-07-22T12:00:00.000Z');
const clock = {
  now: (): number => nowMs,
  iso: (): string => new Date(nowMs).toISOString(),
  advanceSeconds: (s: number): void => {
    nowMs += s * 1000;
  },
};

/** Deterministic "randomness": walks 0, 1/3, 2/3, 0, … so rotation is assertable. */
let randomTick = 0;
const fakeRandom = (): number => {
  const seq = [0, 0.34, 0.67, 0.99];
  const v = seq[randomTick % seq.length] as number;
  randomTick++;
  return v;
};

let itemId = 1000;
function makeMessage(
  text: string,
  opts: {
    member?: string;
    group?: number;
    quotedFromBot?: boolean;
    forwarded?: boolean;
  } = {},
): CapturedMessage {
  return {
    groupId: opts.group ?? GROUP,
    groupName: 'archive',
    itemId: itemId++,
    sharedMsgId: undefined,
    senderMemberId: opts.member ?? ALICE,
    senderDisplayName: opts.member === BOB ? 'Bob' : 'Alice',
    sentAt: clock.iso(),
    type: 'text',
    text,
    linkPreview: undefined,
    file: undefined,
    forwarded: opts.forwarded ?? false,
    quotedFromBot: opts.quotedFromBot ?? false,
    raw: {} as T.AChatItem,
  };
}

async function main(): Promise<void> {
  setLogLevel('error'); // keep the harness output readable

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

  let settings: InteractionSettings = normalizeInteraction({});
  // `replies` carries the text (what every existing assertion reads); `sent`
  // carries the same messages WITH their transport flag, so the presentation
  // rules of CCB-S3-003 can be asserted without weakening anything above.
  const replies: string[] = [];
  const sent: { text: string; quote: boolean }[] = [];

  // Pinned assets this instance "already knows" (CCB-S3-008 §1). Carry-over may
  // only ever reuse one of these; anything else must not reach a provider.
  const pinned = new Set(['MONERO', 'XMR', 'BTC']);
  /** Symbols a carried-over lookup actually asked about — must stay noise-free. */
  const priceAsked: string[] = [];

  const engine = new InteractionEngine({
    db,
    settings: () => settings,
    prices: {
      price: async (base) => {
        priceAsked.push(base);
        return Promise.resolve({
          kind: 'price' as const,
          amount: 1,
          base: { symbol: base.toUpperCase(), decimals: 8 },
          quote: { symbol: 'USD', decimals: 2 },
          value: 349.41,
          at: clock.now(),
          provider: 'coingecko',
          attribution: 'Data by CoinGecko',
        });
      },
      pin: () => Promise.resolve({}),
      isPinned: (symbol: string) => Promise.resolve(pinned.has(symbol.trim().toUpperCase())),
    },
    priceSettings: () => ({
      rateLimitPerMember: 100,
      rateLimitPerChat: 100,
      disclaimer: '',
    }),
    send: async (_msg, text, opts) => {
      replies.push(text);
      sent.push({ text, quote: opts.quote });
      return Promise.resolve();
    },
    now: clock.now,
    random: fakeRandom,
  });

  /** Sends one message through the engine and returns what she said back. */
  async function say(
    text: string,
    opts: {
      member?: string;
      group?: number;
      quotedFromBot?: boolean;
      forwarded?: boolean;
    } = {},
  ): Promise<{ handled: boolean; replies: string[]; sent: { text: string; quote: boolean }[] }> {
    replies.length = 0;
    sent.length = 0;
    const handled = await engine.handle(makeMessage(text, opts));
    return { handled, replies: [...replies], sent: [...sent] };
  }

  /** Resets conversational state between scenarios by moving past every window. */
  function coolDown(): void {
    clock.advanceSeconds(3600);
  }

  async function consentRow(member: string): Promise<{ optedIn: boolean; revoked: boolean }> {
    const c = await getConsent(db, member);
    return { optedIn: c !== null, revoked: c?.revokedAt != null };
  }

  async function clearConsent(member: string): Promise<void> {
    await db.query('DELETE FROM consent WHERE member_id = $1', [member]);
    await db.query('DELETE FROM consent_actions WHERE member_id = $1', [member]);
  }

  /* ── 1. Addressing: the wake word ─────────────────────────────────────── */

  section('1. Addressing — wake word, greetings, strict anchoring');

  check(
    '"Cinderella, publish me" is an address',
    detectAddress('Cinderella, publish me', settings).kind === 'wake',
  );
  check(
    '"Hey Cinderella publish me" is an address',
    detectAddress('Hey Cinderella publish me', settings).kind === 'wake',
  );
  check(
    '"hi cinderella - publish me" is an address with the greeting stripped',
    detectAddress('hi cinderella - publish me', settings).instruction === 'publish me',
  );
  check(
    '"Guten Morgen Cinderella, veröffentliche mich" is an address',
    detectAddress('Guten Morgen Cinderella, veröffentliche mich', settings).kind === 'wake',
  );
  check(
    'typo "Cinderela publish me" is still an address',
    detectAddress('Cinderela publish me', settings).kind === 'wake',
  );
  check(
    'typo "Cinderlla publish me" is still an address',
    detectAddress('Cinderlla publish me', settings).kind === 'wake',
  );
  check(
    '"I think Cinderella is great" is NOT an address',
    detectAddress('I think Cinderella is great', settings).kind === 'none',
  );
  check(
    '"Cinderella\'s archive is nice" is NOT an address (possessive)',
    detectAddress("Cinderella's archive is nice", settings).kind === 'none',
  );
  check(
    '"Cinderellas Archiv ist gut" is NOT an address (compound)',
    detectAddress('Cinderellas Archiv ist gut', settings).kind === 'none',
  );
  check(
    '"what happens if I say Cinderella publish me" is NOT an address',
    detectAddress('what happens if I say Cinderella publish me', settings).kind === 'none',
  );

  /* ── 2. The resolver ───────────────────────────────────────────────────── */

  section('2. Intent resolver — catalog, typo tolerance, guards');

  const ctx = { threshold: settings.confidenceThreshold, defaultLanguage: 'en' };
  const r = async (t: string): Promise<Awaited<ReturnType<typeof resolveIntent>>> =>
    resolveIntent(t, ctx);

  check('"publish me" → PUBLISH', (await r('publish me')).intent === 'PUBLISH');
  check(
    '"can you publish my stuff?" → PUBLISH',
    (await r('can you publish my stuff?')).intent === 'PUBLISH',
  );
  check('typo "publsh me" → PUBLISH', (await r('publsh me')).intent === 'PUBLISH');
  check('typo "puplish me" → PUBLISH', (await r('puplish me')).intent === 'PUBLISH');
  check(
    'German "veröffentliche mich" → PUBLISH',
    (await r('veröffentliche mich')).intent === 'PUBLISH',
  );
  check(
    'umlaut-free "veroeffentliche mich" → PUBLISH',
    (await r('veroeffentliche mich')).intent === 'PUBLISH',
  );
  check('"unpublish me" → UNPUBLISH', (await r('unpublish me')).intent === 'UNPUBLISH');
  check(
    '"stop publishing" → UNPUBLISH (phrase outranks the "publish" keyword)',
    (await r('stop publishing')).intent === 'UNPUBLISH',
  );
  check(
    'German "widerrufe meine Zustimmung" → UNPUBLISH',
    (await r('widerrufe meine Zustimmung')).intent === 'UNPUBLISH',
  );
  check(
    '"what do you have on me" → STATUS',
    (await r('what do you have on me')).intent === 'STATUS',
  );
  check(
    'German "was hast du über mich" → STATUS',
    (await r('was hast du über mich')).intent === 'STATUS',
  );
  const searchResult = await r('search for pizza');
  check('"search for pizza" → SEARCH', searchResult.intent === 'SEARCH');
  check('SEARCH carries the query slot', searchResult.slots.query === 'pizza');
  check('"what can you do" → HELP', (await r('what can you do')).intent === 'HELP');
  check('"undo that" → UNDO', (await r('undo that')).intent === 'UNDO');
  check('gibberish → UNKNOWN', (await r('flurble wibbet')).intent === 'UNKNOWN');

  check(
    'negation "don\'t publish me" → UNKNOWN (ask, do not act)',
    (await r("don't publish me")).intent === 'UNKNOWN',
  );
  check(
    'German negation "veröffentliche mich nicht" → UNKNOWN',
    (await r('veröffentliche mich nicht')).intent === 'UNKNOWN',
  );
  check(
    'hypothetical "what happens if I say publish me" → UNKNOWN',
    (await r('what happens if I say publish me')).intent === 'UNKNOWN',
  );
  check(
    'quoted \'the rule is "publish me"\' → UNKNOWN',
    (await r('the rule is "publish me"')).intent === 'UNKNOWN',
  );

  const thirdParty = await r('publish Max');
  check('"publish Max" flags a third-party target', thirdParty.slots.targetName === 'Max');
  check(
    '"publish him" flags a third-party target',
    (await r('publish him')).slots.targetName !== undefined,
  );
  check(
    'German "veröffentliche meine Fotos" does NOT flag a target (capitalised noun)',
    (await r('veröffentliche meine Fotos')).slots.targetName === undefined,
  );
  check(
    '"publish my messages" does NOT flag a target',
    (await r('publish my messages')).slots.targetName === undefined,
  );

  /* ── 3. The resolver never executes ────────────────────────────────────── */

  section('3. The resolver never executes anything');

  await clearConsent(ALICE);
  await r('publish me');
  await r('unpublish me');
  await r('undo that');
  const afterResolving = await consentRow(ALICE);
  check('resolving PUBLISH/UNPUBLISH/UNDO wrote no consent row', afterResolving.optedIn === false);
  const journalAfterResolving = await memberConsentHistory(db, ALICE);
  check('resolving wrote no consent journal entry', journalAfterResolving.length === 0);

  /* ── 4. The AI seam ────────────────────────────────────────────────────── */

  section('4. The AI seam — catalog enforcement and automatic fallback');

  setIntentResolver({
    name: 'stub-out-of-catalog',
    resolve: () =>
      Promise.resolve({
        intent: 'DELETE_EVERYTHING',
        confidence: 1,
        slots: {},
        lang: 'en',
      } as never),
  });
  check(
    'an out-of-catalog intent is forced to UNKNOWN',
    (await resolveIntent('publish me', ctx)).intent === 'UNKNOWN',
  );

  setIntentResolver({
    name: 'stub-throws',
    resolve: () => Promise.reject(new Error('endpoint unreachable')),
  });
  check(
    'a failing resolver falls back to the rule engine',
    (await resolveIntent('publish me', ctx)).intent === 'PUBLISH',
  );

  resetIntentResolver();
  check(
    'the rule engine is restored as the active resolver',
    (await resolveIntent('publish me', ctx)).intent === 'PUBLISH',
  );

  /* ── 5. Confirmation flow ──────────────────────────────────────────────── */

  section('5. Confirmation flow — publish, unpublish, decline');

  await clearConsent(ALICE);
  coolDown();

  const ask = await say('Cinderella publish me');
  check('"Cinderella publish me" is handled as a control message', ask.handled);
  check('she asks for confirmation', ask.replies[0]?.includes('Say *yes*') === true);
  check('nothing is published yet', (await consentRow(ALICE)).optedIn === false);

  const confirm = await say('yes');
  check('"yes" (no wake word, inside the window) is understood', confirm.handled);
  check(
    'she confirms it is done',
    confirm.replies[0]?.includes('shine in the public archive') === true,
  );
  const optedIn = await consentRow(ALICE);
  check('the opt-in is recorded', optedIn.optedIn && !optedIn.revoked);

  const history = await memberConsentHistory(db, ALICE);
  check('the decision is journalled as natural language', history[0]?.source === 'natural');
  check('the journal records it as an opt-in', history[0]?.action === 'opt_in');

  coolDown();
  const askOut = await say('Cinderella, can you unpublish me?');
  check('unpublish also asks first', askOut.replies[0]?.includes('Say *yes*') === true);
  check('still opted in while unconfirmed', (await consentRow(ALICE)).revoked === false);
  const confirmOut = await say('yes');
  check(
    'she confirms the withdrawal',
    confirmOut.replies[0]?.includes('Back into the dark') === true,
  );
  check('the opt-out is recorded', (await consentRow(ALICE)).revoked === true);

  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella publish me');
  const declined = await say('no');
  check(
    'declining answers and does nothing',
    declined.replies[0]?.includes('nothing is done') === true,
  );
  check('a declined confirmation publishes nothing', (await consentRow(ALICE)).optedIn === false);

  coolDown();
  await clearConsent(ALICE);
  const askTypo = await say('hi cinderella publsh me');
  check(
    'typos in the wake word AND the instruction still reach the confirmation',
    askTypo.replies[0]?.includes('Say *yes*') === true,
  );
  await say('yep');
  check('a fuzzy affirmation ("yep") confirms', (await consentRow(ALICE)).optedIn === true);

  /* ── 6. Third-party refusal ────────────────────────────────────────────── */

  section('6. Third-party refusal — consent is first-person only');

  coolDown();
  await clearConsent(BOB);
  const refused = await say('Cinderella publish Max', { member: BOB });
  check('she refuses in her own voice', refused.replies[0]?.includes('not mine to cast') === true);
  check('the refusal names the third party', refused.replies[0]?.includes('Max') === true);
  check('no consent is recorded for the requester', (await consentRow(BOB)).optedIn === false);
  const bobJournal = await memberConsentHistory(db, BOB);
  check('no consent action is journalled at all', bobJournal.length === 0);

  const afterRefusal = await say('yes', { member: BOB });
  check(
    'a following "yes" cannot complete a refused request',
    (await consentRow(BOB)).optedIn === false,
  );
  check('and she does not treat it as a confirmation', !afterRefusal.replies[0]?.includes('shine'));

  coolDown();
  const refusedPronoun = await say('Cinderella publish him', { member: BOB });
  check(
    '"publish him" is refused too',
    refusedPronoun.replies[0]?.includes('not mine to cast') === true,
  );

  /* ── 7. Follow-up window and reply-to ──────────────────────────────────── */

  section('7. Follow-up window and direct replies');

  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella what can you do');
  clock.advanceSeconds(30);
  const inWindow = await say('publish me');
  check('a follow-up without the wake word works inside the window', inWindow.handled);
  check('it reaches the confirmation', inWindow.replies[0]?.includes('Say *yes*') === true);

  coolDown();
  await say('Cinderella what can you do');
  clock.advanceSeconds(90); // past the 60s window
  const outOfWindow = await say('publish me');
  check('the same message after the window is ignored', !outOfWindow.handled);
  check('and she stays silent', outOfWindow.replies.length === 0);

  coolDown();
  const replyToBot = await say('publish me', { quotedFromBot: true });
  check('a direct reply to one of her messages needs no wake word', replyToBot.handled);
  check('and it reaches the confirmation', replyToBot.replies[0]?.includes('Say *yes*') === true);

  coolDown();
  await say('Cinderella what can you do');
  clock.advanceSeconds(10);
  const chatter = await say('what happens if I say publish me');
  check(
    'a hypothetical inside the window is archived, not acted on',
    !chatter.handled && chatter.replies.length === 0,
  );

  coolDown();
  await say('Cinderella what can you do');
  clock.advanceSeconds(10);
  const bareKeyword = await say("I'll publish the photos later");
  check(
    'a bare keyword inside the window does not make her interject',
    !bareKeyword.handled && bareKeyword.replies.length === 0,
  );
  clock.advanceSeconds(10);
  const realInstruction = await say('publish me');
  check(
    'but a real instruction inside the window still works',
    realInstruction.replies[0]?.includes('Say *yes*') === true,
  );

  /* ── 8. Read-only intents ──────────────────────────────────────────────── */

  section('8. Status, search and help');

  coolDown();
  await clearConsent(ALICE);
  for (let i = 0; i < 5; i++) {
    await upsertMessage(db, {
      groupId: GROUP,
      groupMsgId: 500 + i,
      sharedMsgId: null,
      senderMemberId: ALICE,
      senderDisplayName: 'Alice',
      sentAt: new Date(nowMs - 60_000).toISOString(),
      type: 'text',
      textBody: i < 2 ? 'pizza night was excellent' : 'ordinary chatter',
      linksText: null,
      rawJson: {},
    });
  }

  const statusBefore = await say('Cinderella what do you have on me');
  check('status reports the total', statusBefore.replies[0]?.includes('5') === true);
  check(
    'status reports nothing public before opting in',
    statusBefore.replies[0]?.includes('I keep 5 of your messages. 0 of them') === true,
  );

  await clearConsent(ALICE);
  await applyConsentChange(db, {
    memberId: ALICE,
    at: new Date(nowMs - 120_000).toISOString(),
    action: 'opt_in',
    source: 'admin',
  });
  coolDown();
  const statusAfter = await say('Cinderella what do you have on me');
  check(
    'status reflects the published subset once opted in',
    statusAfter.replies[0]?.includes('I keep 5 of your messages. 5 of them') === true,
  );

  coolDown();
  const search = await say('Cinderella search for pizza');
  check('search answers with a count', search.replies[0]?.includes('I found 2 moments') === true);
  check('search echoes the query', search.replies[0]?.includes('pizza') === true);

  coolDown();
  const help = await say('Cinderella what can you do');
  check(
    'help names her and lists a capability',
    help.replies[0]?.includes('Cinderella') === true && /publish/i.test(help.replies[0] ?? ''),
  );

  coolDown();
  // CCB-S3-005: a GREETED message is a strong address signal, so an
  // unrecognised one still gets the prompt. The bare-name form is now silent —
  // asserted in section 16.
  const puzzled = await say('Hey Cinderella flurble wibbet');
  check(
    'a clearly-addressed but unrecognised message gets the "not understood" answer',
    puzzled.replies[0]?.includes('did not quite catch that') === true,
  );
  check('and is treated as a control message, not archived', puzzled.handled);

  /* ── 9. Undo ───────────────────────────────────────────────────────────── */

  section('9. Undo');

  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella publish me');
  await say('yes');
  check('opted in before the undo', (await consentRow(ALICE)).optedIn === true);

  // Inside the undo window (default 300s) — a coolDown here would be testing the
  // expiry case, which has its own check below.
  clock.advanceSeconds(10);
  const undone = await say('Cinderella undo that');
  check('she confirms the undo', undone.replies[0]?.includes('Undone') === true);
  check('the opt-in is gone entirely', (await consentRow(ALICE)).optedIn === false);

  clock.advanceSeconds(10);
  const nothingToUndo = await say('Cinderella undo that');
  check(
    'a second undo finds nothing',
    nothingToUndo.replies[0]?.includes('nothing recent') === true,
  );

  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella publish me');
  await say('yes');
  clock.advanceSeconds(settings.undoWindowSeconds + 60);
  const tooLate = await say('Cinderella undo that');
  check(
    'an undo outside the window is refused',
    tooLate.replies[0]?.includes('nothing recent') === true,
  );
  check('and the consent stands', (await consentRow(ALICE)).optedIn === true);

  /* ── 10. Nicknames ─────────────────────────────────────────────────────── */

  section('10. Nicknames — retort only, rotation, anti-spam');

  coolDown();
  await clearConsent(ALICE);
  const nick = await say('Cindy publish me');
  check('a nickname gets a retort', nick.replies.length === 1);
  check(
    'the retort is one of the configured retorts',
    (DEFAULT_INTERACTION.retorts['en'] as string[]).includes(nick.replies[0] as string),
  );
  check('no publish happens', (await consentRow(ALICE)).optedIn === false);

  const afterNickname = await say('yes');
  check(
    'no confirmation is pending after a nickname',
    !afterNickname.replies[0]?.includes('shine'),
  );
  check('and no follow-up window was opened', !afterNickname.handled);

  const seen: string[] = [nick.replies[0] as string];
  let repeatedBackToBack = false;
  for (let i = 0; i < 2; i++) {
    const again = await say('Cindy publish me');
    const said = again.replies[0];
    if (said !== undefined) {
      if (said === seen[seen.length - 1]) repeatedBackToBack = true;
      seen.push(said);
    }
  }
  check('retorts rotate without repeating the previous one', !repeatedBackToBack);
  check('three nicknames produced three retorts', seen.length === 3);

  const spammed = await say('Cindy publish me');
  check(
    'past the anti-spam limit she stays silent',
    spammed.replies.length === 0 && spammed.handled,
  );

  coolDown(); // the streak is forgiven after a rest
  await clearConsent(ALICE);
  const properName = await say('Cinderella publish me');
  check(
    'using her proper name works normally again',
    properName.replies[0]?.includes('Say *yes*') === true,
  );

  settings = normalizeInteraction({
    ...settings,
    nicknames: { ...settings.nicknames, enabled: false },
  });
  coolDown();
  const nicknamesOff = await say('Cindy publish me');
  check(
    'with nicknames disabled she ignores the nickname entirely',
    !nicknamesOff.handled && nicknamesOff.replies.length === 0,
  );
  settings = normalizeInteraction({});

  /* ── 11. Persona and language ──────────────────────────────────────────── */

  section('11. Persona strings — German, and admin-editable');

  coolDown();
  await clearConsent(ALICE);
  const germanAsk = await say('Cinderella veröffentliche mich');
  check(
    'a German instruction is answered in German',
    germanAsk.replies[0]?.includes('Sag *ja*') === true,
  );
  const germanConfirm = await say('ja');
  check(
    '"ja" confirms and she answers in German',
    germanConfirm.replies[0]?.includes('im öffentlichen Archiv') === true,
  );
  check('the opt-in is recorded', (await consentRow(ALICE)).optedIn === true);

  const custom = normalizeInteraction({
    persona: { en: { published: 'CUSTOM PUBLISHED STRING' } },
  });
  check(
    'an edited persona string is kept',
    custom.persona['en']?.published === 'CUSTOM PUBLISHED STRING',
  );
  check(
    'unedited persona strings keep their shipped default',
    custom.persona['en']?.unpublished === DEFAULT_INTERACTION.persona['en']?.unpublished,
  );
  check('German persona strings survive an English-only edit', custom.persona['de'] !== undefined);

  settings = custom;
  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella publish me');
  const customReply = await say('yes');
  check(
    'the edited string is what she actually says',
    customReply.replies[0] === 'CUSTOM PUBLISHED STRING',
  );
  settings = normalizeInteraction({});

  /* ── 12. Settings take effect ──────────────────────────────────────────── */

  section('12. Settings — renaming her, toggles, thresholds, limits');

  settings = normalizeInteraction({ ...settings, wakeWord: 'Aschenputtel' });
  coolDown();
  await clearConsent(ALICE);
  const renamed = await say('Aschenputtel publish me');
  check('the renamed wake word is heard', renamed.replies[0]?.includes('Say *yes*') === true);
  coolDown();
  const oldName = await say('Cinderella publish me');
  check('the old name no longer addresses her', !oldName.handled && oldName.replies.length === 0);
  settings = normalizeInteraction({});

  settings = normalizeInteraction({ ...settings, naturalAddressing: false });
  coolDown();
  const naturalOff = await say('Cinderella publish me');
  check(
    'natural addressing off silences the whole layer',
    !naturalOff.handled && naturalOff.replies.length === 0,
  );
  settings = normalizeInteraction({});

  settings = normalizeInteraction({ ...settings, followUpSeconds: 0 });
  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella publish me');
  const noWindow = await say('yes');
  check(
    'a zero follow-up window means "yes" alone is not an answer',
    (await consentRow(ALICE)).optedIn === false && !noWindow.handled,
  );
  settings = normalizeInteraction({});

  settings = normalizeInteraction({ ...settings, confidenceThreshold: 0.99 });
  coolDown();
  // Greeted, so the weak-signal silence rule (CCB-S3-005) does not mask what
  // this check is actually about: the confidence threshold.
  const strict = await say('Hey Cinderella publsh me');
  check(
    'a high confidence threshold makes her ask instead of act',
    strict.replies[0]?.includes('did not quite catch that') === true,
  );
  settings = normalizeInteraction({});

  settings = normalizeInteraction({ ...settings, replyLimitPerMember: 2 });
  coolDown();
  const first = await say('Cinderella what can you do');
  const second = await say('Cinderella what can you do');
  const third = await say('Cinderella what can you do');
  check(
    'the per-member reply rate limit silences her after the budget',
    first.replies.length === 1 && second.replies.length === 1 && third.replies.length === 0,
  );
  settings = normalizeInteraction({});

  check(
    'an out-of-range confidence threshold is clamped',
    normalizeInteraction({ confidenceThreshold: 9 }).confidenceThreshold === 1,
  );
  check(
    'an empty wake word falls back to the default',
    normalizeInteraction({ wakeWord: '   ' }).wakeWord === 'Cinderella',
  );
  check(
    'an emptied retort list falls back to the shipped twelve',
    normalizeInteraction({ retorts: { en: '' } }).retorts['en']?.length === 12,
  );
  check(
    'greetings accept a comma-separated admin field',
    normalizeInteraction({ greetings: 'hi, hey, moin' }).greetings.length === 3,
  );
  check(
    'retorts accept a newline-separated admin field',
    normalizeInteraction({ retorts: { en: 'one\ntwo\nthree' } }).retorts['en']?.length === 3,
  );

  /* ── 13. Slash commands are unchanged ──────────────────────────────────── */

  section('13. Slash commands behave exactly as before');

  check('"/publish" still parses', parseConsentCommand('/publish') === 'publish');
  check('"/unpublish" still parses', parseConsentCommand('/unpublish') === 'unpublish');
  check('"publish" alone is not a command', parseConsentCommand('publish') === null);

  await clearConsent(BOB);
  await applyConsentChange(db, {
    memberId: BOB,
    at: clock.iso(),
    action: 'opt_in',
    source: 'slash',
  });
  const slashState = await consentRow(BOB);
  check('a slash opt-in takes effect immediately, with no confirmation', slashState.optedIn);
  const slashJournal = await memberConsentHistory(db, BOB);
  check('and is journalled with its source', slashJournal[0]?.source === 'slash');

  /* ── 14. Reply presentation (CCB-S3-003) ──────────────────────────────── */

  section('14. Reply presentation — no quote clutter, correct markdown');

  // The markup guard. SimpleX renders SINGLE-character delimiters (*bold*,
  // _italic_, ~strike~, `code`, #secret#); DOUBLING any of them makes the
  // delimiters render literally. Verified directly against the 6.5.4 core.
  // This check exists so a CommonMark habit cannot creep back into the copy.
  // All five delimiters, doubled — not just the CommonMark-shaped ones, so the
  // guard covers the rule it states rather than the mistake we happened to make.
  const DOUBLED = /\*\*|__|~~|``|##/;
  const shipped = normalizeInteraction({});
  const badMarkup: string[] = [];
  for (const [lang, strings] of Object.entries(shipped.persona)) {
    for (const [key, value] of Object.entries(strings)) {
      if (DOUBLED.test(value)) badMarkup.push(`persona.${lang}.${key}`);
    }
  }
  for (const [lang, list] of Object.entries(shipped.retorts)) {
    list.forEach((value, i) => {
      if (DOUBLED.test(value)) badMarkup.push(`retorts.${lang}[${i}]`);
    });
  }
  for (const [lang, tpl] of Object.entries(shipped.namePrefix.templates)) {
    if (DOUBLED.test(tpl)) badMarkup.push(`namePrefix.${lang}`);
  }
  check(
    'no persona string, retort or prefix uses a DOUBLED markdown delimiter',
    badMarkup.length === 0,
    badMarkup.join(', '),
  );
  check(
    'the confirmation prompts use single-asterisk bold, which SimpleX renders',
    shipped.persona['en']?.publishConfirm.includes('*yes*') === true &&
      shipped.persona['de']?.publishConfirm.includes('*ja*') === true,
  );
  check(
    'the first retort uses single-asterisk bold in both languages',
    shipped.retorts['en']?.[0]?.includes('*Cinderella*') === true &&
      shipped.retorts['de']?.[0]?.includes('*Cinderella*') === true,
  );

  // Presentation defaults.
  check('the shipped reply mode is the non-quoting one', shipped.replyMode === 'plain');
  check(
    'an unknown reply mode falls back to plain',
    normalizeInteraction({ replyMode: 'bogus' }).replyMode === 'plain',
  );
  check(
    'the name prefix ships enabled with a {name} template',
    shipped.namePrefix.enabled && shipped.namePrefix.templates['en']?.includes('{name}') === true,
  );

  settings = normalizeInteraction({});
  coolDown();
  await clearConsent(ALICE);

  const plainAsk = await say('Cinderella publish me');
  check('plain mode does not quote', plainAsk.sent[0]?.quote === false);
  check('plain mode adds no name prefix', plainAsk.sent[0]?.text.startsWith('🕯️') === true);
  const plainOutcome = await say('yes');
  check('a consent outcome does not quote either', plainOutcome.sent[0]?.quote === false);

  settings = normalizeInteraction({ ...settings, replyMode: 'mention' });
  coolDown();
  await clearConsent(ALICE);
  const mentionAsk = await say('Cinderella publish me');
  check(
    'mention mode opens with the member name',
    mentionAsk.sent[0]?.text.startsWith('Alice, 🕯️') === true,
    mentionAsk.sent[0]?.text.slice(0, 24),
  );
  check('mention mode still does not quote', mentionAsk.sent[0]?.quote === false);

  settings = normalizeInteraction({
    ...settings,
    replyMode: 'mention',
    namePrefix: { enabled: false, templates: {} },
  });
  coolDown();
  const prefixOff = await say('Cinderella what can you do');
  check(
    'the name prefix can be switched off, leaving mention identical to plain',
    prefixOff.sent[0]?.text.startsWith('🕯️') === true && prefixOff.sent[0]?.quote === false,
  );

  settings = normalizeInteraction({ ...settings, replyMode: 'quote' });
  coolDown();
  const quotedStatus = await say('Cinderella what do you have on me');
  check('quote mode restores the previous behaviour', quotedStatus.sent[0]?.quote === true);

  coolDown();
  await clearConsent(ALICE);
  const quotedAsk = await say('Cinderella publish me');
  check(
    'a confirmation prompt NEVER quotes, even in quote mode',
    quotedAsk.sent[0]?.quote === false,
  );

  coolDown();
  const quotedRetort = await say('Cindy publish me');
  check('a nickname retort never quotes', quotedRetort.sent[0]?.quote === false);

  // Asserted in MENTION mode with the prefix ENABLED — otherwise "no prefix"
  // would pass simply because prefixing was off, and the check would be vacuous.
  settings = normalizeInteraction({
    ...settings,
    replyMode: 'mention',
    namePrefix: { enabled: true, templates: { en: '{name},', de: '{name},' } },
  });
  coolDown();
  const mentionRetort = await say('Cindy publish me');
  check(
    'a nickname retort carries no name prefix even when prefixing is on',
    mentionRetort.sent[0]?.text.startsWith('Alice') === false &&
      mentionRetort.sent[0]?.quote === false,
    mentionRetort.sent[0]?.text.slice(0, 20),
  );
  // …and the same settings DO prefix a normal answer, proving the mode was live.
  coolDown();
  const mentionControl = await say('Cinderella what can you do');
  check(
    'the control: mention mode was genuinely active for that retort check',
    mentionControl.sent[0]?.text.startsWith('Alice, ') === true,
  );

  settings = normalizeInteraction({});

  // Display names are member-controlled and SimpleX parses formatting in what we
  // send. A paired delimiter in a name would open a span (verified: `#Robin#`
  // renders as a spoiler), which would hide the very name the prefix exists to show.
  check(
    'a display name cannot inject formatting into the prefix',
    sanitizeDisplayName('#Robin#') === 'Robin' &&
      sanitizeDisplayName('Ro*bin') === 'Robin' &&
      sanitizeDisplayName('a`b~c') === 'abc',
  );
  check(
    'a display name cannot break the reply across lines',
    sanitizeDisplayName('Bob\nEvil') === 'Bob Evil',
  );
  check(
    'underscores survive (they do not italicise inside a word)',
    sanitizeDisplayName('sascha_d') === 'sascha_d',
  );
  check('an over-long display name is bounded', sanitizeDisplayName('x'.repeat(200)).length === 64);

  // The pure formatter, directly.
  check(
    'formatOutbound: plain leaves the body untouched',
    formatOutbound('body', { mode: 'plain', prefixTemplate: '{name},', displayName: 'Alice' })
      .text === 'body',
  );
  check(
    'formatOutbound: mention adds exactly one space after the prefix',
    formatOutbound('body', { mode: 'mention', prefixTemplate: '{name},', displayName: 'Alice' })
      .text === 'Alice, body',
  );
  check(
    'formatOutbound: allowQuote=false beats quote mode',
    formatOutbound('body', {
      mode: 'quote',
      prefixTemplate: null,
      displayName: 'Alice',
      allowQuote: false,
    }).quote === false,
  );
  check(
    'formatOutbound: a name that sanitises to nothing yields no stray prefix',
    formatOutbound('body', { mode: 'mention', prefixTemplate: '{name},', displayName: '###' })
      .text === 'body',
  );

  /* ── 16. Address guards + reply language (CCB-S3-005) ──────────────────── */

  section('16. Address guards — forwarded, weak signals, length, strict mode');

  settings = normalizeInteraction({});
  clearNearMisses();
  coolDown();
  await clearConsent(ALICE);

  // The message that caused this briefing: a long forwarded announcement whose
  // first word is her name. Reproduced in shape, not verbatim — the live text is
  // a member's message and does not belong in a public repository. What matters
  // is reproduced exactly: forwarded, opens with the wake word, is long, and
  // quotes the very commands it documents.
  const ANNOUNCEMENT =
    'Cinderella now understands plain language\n\n' +
    'You can now talk to Cinderella instead of typing commands. Address her by name and ' +
    'say what you want: Cinderella publish me, Cinderella, would you withdraw my ' +
    'publication?, Hey Cinderella, what do you have on me?. Slash commands still work. ' +
    'Hallo Cinderella works too, because the wake word is her name in every language. ' +
    'Nothing is published without your explicit yes, and she will never act for anyone ' +
    'but you.';

  // Establish that this text really is dangerous without the guards, so the
  // checks below are not proving something vacuous.
  const dangerous = await resolveIntent(ANNOUNCEMENT.slice(0, 240), {
    threshold: settings.confidenceThreshold,
    defaultLanguage: 'en',
  });
  check(
    'the announcement text really does resolve to a consent intent without the guards',
    dangerous.intent === 'PUBLISH' && dangerous.confidence >= 0.8,
    `${dangerous.intent} @ ${dangerous.confidence.toFixed(2)}`,
  );

  const forwarded = await say(ANNOUNCEMENT, { forwarded: true });
  check(
    'a FORWARDED announcement produces no reply at all',
    !forwarded.handled && forwarded.replies.length === 0,
  );
  check('no consent was touched by it', (await consentRow(ALICE)).optedIn === false);
  check(
    'and it is recorded as a near miss with the reason',
    recentNearMisses(1)[0]?.reason === 'forwarded',
  );

  clearNearMisses();
  coolDown();
  const forwardedShort = await say('Cinderella publish me', { forwarded: true });
  check(
    'ANY forwarded message is ignored, even a perfect instruction',
    !forwardedShort.handled && forwardedShort.replies.length === 0,
  );
  check('a forwarded instruction changes no consent', (await consentRow(ALICE)).optedIn === false);

  // Weak signal + UNKNOWN → silence.
  clearNearMisses();
  coolDown();
  const weakUnknown = await say('Cinderella now understands plain language');
  check(
    'a bare-name message she cannot understand gets NO reply',
    !weakUnknown.handled && weakUnknown.replies.length === 0,
  );
  check(
    'and the near miss says why',
    recentNearMisses(1)[0]?.reason === 'weak-signal-unknown',
    recentNearMisses(1)[0]?.reason,
  );

  coolDown();
  const strongUnknown = await say('Hey Cinderella blargh');
  check(
    'a GREETED message she cannot understand DOES get the not-understood prompt',
    strongUnknown.replies[0]?.includes('did not quite catch that') === true,
  );

  coolDown();
  await clearConsent(ALICE);
  const bareInstruction = await say('Cinderella publish me');
  check(
    'a bare-name message she DOES understand still works',
    bareInstruction.replies[0]?.includes('Say *yes*') === true,
  );

  // Length guard.
  clearNearMisses();
  coolDown();
  const longWaffle =
    'Cinderella ' +
    'this is a long announcement about many things and none of them are a command '.repeat(4);
  const longMsg = await say(longWaffle);
  check(
    'a long message beginning with her name is ignored',
    !longMsg.handled && longMsg.replies.length === 0,
  );
  check('recorded as too-long', recentNearMisses(1)[0]?.reason === 'too-long');

  coolDown();
  await clearConsent(ALICE);
  const longButClear = await say('Cinderella ' + 'please '.repeat(30) + 'publish me');
  check(
    'a long message WITH a high-confidence intent is still acted on',
    longButClear.replies[0]?.includes('Say *yes*') === true,
  );

  // Strict mode.
  settings = normalizeInteraction({
    ...settings,
    addressing: { ...settings.addressing, mode: 'strict' },
  });
  clearNearMisses();
  coolDown();
  await clearConsent(ALICE);
  const strictBare = await say('Cinderella publish me');
  check(
    'strict mode ignores a bare leading name',
    !strictBare.handled && strictBare.replies.length === 0,
  );
  check(
    'and says so in the near-miss log',
    recentNearMisses(1)[0]?.reason === 'strict-mode-no-greeting',
  );
  coolDown();
  const strictGreeted = await say('Hey Cinderella publish me');
  check(
    'strict mode accepts a greeted instruction',
    strictGreeted.replies[0]?.includes('Say *yes*') === true,
  );
  coolDown();
  const strictReply = await say('publish me', { quotedFromBot: true });
  check(
    'strict mode still accepts a direct reply to her',
    strictReply.replies[0]?.includes('Say *yes*') === true,
  );
  clock.advanceSeconds(10);
  const strictWindow = await say('what can you do');
  check('strict mode still honours the follow-up window', strictWindow.handled);

  // Individually switchable.
  settings = normalizeInteraction({
    ...settings,
    addressing: { ...settings.addressing, mode: 'relaxed', ignoreForwarded: false },
  });
  coolDown();
  await clearConsent(ALICE);
  const forwardedAllowed = await say('Cinderella publish me', { forwarded: true });
  check(
    'switching ignoreForwarded OFF restores the old (unsafe) behaviour',
    forwardedAllowed.replies[0]?.includes('Say *yes*') === true,
  );

  settings = normalizeInteraction({
    ...settings,
    addressing: { ...settings.addressing, ignoreForwarded: true, silenceOnUnknown: false },
  });
  coolDown();
  const noSilence = await say('Cinderella now understands plain language');
  check(
    'switching silenceOnUnknown OFF makes her answer weak-signal UNKNOWNs again',
    noSilence.replies[0]?.includes('did not quite catch that') === true,
  );

  settings = normalizeInteraction({});

  /* ── 17. Reply language (CCB-S3-005 §6) ────────────────────────────────── */

  section('17. Reply language — answer in the language of the message');

  check(
    'ROOT CAUSE: one German word no longer flips a long English message',
    detectLanguage(ANNOUNCEMENT, 'en').lang === 'en',
    `detected ${detectLanguage(ANNOUNCEMENT, 'en').lang}`,
  );
  check(
    'the single word that caused it ("hallo") is present in the fixture',
    /hallo/i.test(ANNOUNCEMENT),
  );
  check(
    'a genuinely German message is still detected as German',
    detectLanguage(
      'Kannst du bitte meine Nachrichten veröffentlichen und mir sagen was du hast',
      'en',
    ).lang === 'de',
  );
  check(
    'an ambiguous fragment is NOT confidently detected',
    detectLanguage('ok', 'en').confident === false,
  );

  settings = normalizeInteraction({
    ...settings,
    addressing: { ...settings.addressing, silenceOnUnknown: false },
  });
  coolDown();
  const englishUnknown = await say('Cinderella blargh wibble frobnicate the thing');
  check(
    'an English message gets an ENGLISH not-understood reply',
    englishUnknown.replies[0]?.includes('did not quite catch that') === true,
    englishUnknown.replies[0]?.slice(0, 40),
  );
  coolDown();
  const germanUnknown = await say('Cinderella kannst du mir bitte sagen was das hier ist');
  check(
    'a German message gets a GERMAN not-understood reply',
    germanUnknown.replies[0]?.includes('nicht ganz erfasst') === true,
    germanUnknown.replies[0]?.slice(0, 40),
  );
  settings = normalizeInteraction({});

  // A whole confirmation exchange stays in one language.
  coolDown();
  await clearConsent(ALICE);
  const dePrompt = await say('Cinderella veröffentliche bitte meine Nachrichten');
  check(
    'German instruction gets a German prompt',
    dePrompt.replies[0]?.includes('Sag *ja*') === true,
  );
  const deConfirm = await say('yes');
  check(
    'and an English-looking "yes" does NOT switch the answer to English mid-handshake',
    deConfirm.replies[0]?.includes('im öffentlichen Archiv') === true,
    deConfirm.replies[0]?.slice(0, 40),
  );

  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella please publish my messages for me');
  const enConfirm = await say('ja');
  check(
    'and the mirror case: an English exchange stays English',
    enConfirm.replies[0]?.includes('shine in the public archive') === true,
    enConfirm.replies[0]?.slice(0, 40),
  );

  // fixed mode
  settings = normalizeInteraction({
    ...settings,
    replyLanguageMode: 'fixed',
    defaultLanguage: 'de',
  });
  coolDown();
  await clearConsent(ALICE);
  const fixedMode = await say('Cinderella please publish my messages for me');
  check(
    'fixed mode answers in the configured language regardless of the message',
    fixedMode.replies[0]?.includes('Sag *ja*') === true,
  );
  settings = normalizeInteraction({
    ...settings,
    replyLanguageMode: 'auto',
    defaultLanguage: 'de',
  });
  coolDown();
  const autoAgain = await say('Cinderella please publish my messages for me');
  check(
    'auto mode overrides the default when the message is clearly English',
    autoAgain.replies[0]?.includes('Say *yes*') === true,
  );
  settings = normalizeInteraction({});

  check(
    'settings: addressing guards and language mode normalise from an admin form',
    normalizeInteraction({ addressing: { mode: 'strict', maxInstructionLength: '350' } }).addressing
      .maxInstructionLength === 350 &&
      normalizeInteraction({ addressing: { mode: 'bogus' } }).addressing.mode === 'relaxed' &&
      normalizeInteraction({ replyLanguageMode: 'bogus' }).replyLanguageMode === 'auto',
  );
  check(
    'settings: the shipped defaults match the briefing',
    DEFAULT_INTERACTION.addressing.mode === 'relaxed' &&
      DEFAULT_INTERACTION.addressing.ignoreForwarded &&
      DEFAULT_INTERACTION.addressing.silenceOnUnknown &&
      DEFAULT_INTERACTION.addressing.maxInstructionLength === 200 &&
      DEFAULT_INTERACTION.addressing.lengthGuardConfidence === 0.8 &&
      DEFAULT_INTERACTION.addressing.logNearMisses &&
      DEFAULT_INTERACTION.replyLanguageMode === 'auto' &&
      DEFAULT_INTERACTION.rememberMemberLanguage,
  );

  /* ── 18. CCB-S3-006 — state questions, carry-over, filler prefixes ────── */

  section('18. CCB-S3-006 — state questions, carry-over, leading fillers');

  settings = normalizeInteraction({});
  coolDown();
  await clearConsent(ALICE);

  // §7a — the reported defect: a question about state produced a consent prompt.
  const statusQ = await say('Cinderella whats my publish status?');
  check(
    'a publish STATE question is answered, not turned into a consent prompt',
    statusQ.replies[0]?.includes('I keep') === true,
    statusQ.replies[0]?.slice(0, 45),
  );
  check('and no confirmation is pending afterwards', (await consentRow(ALICE)).optedIn === false);
  const afterStatusQ = await say('yes');
  check(
    'so a following "yes" cannot opt anyone in',
    (await consentRow(ALICE)).optedIn === false && !afterStatusQ.replies[0]?.includes('shine'),
  );

  coolDown();
  const actionQ = await say('Cinderella can you publish me?');
  check(
    'but a genuine request still asks for confirmation',
    actionQ.replies[0]?.includes('Say *yes*') === true,
  );

  coolDown();
  const statsQ = await say('Cinderella statistics?');
  check('"statistics?" is understood as STATUS', statsQ.replies[0]?.includes('I keep') === true);

  // §7d — a short discourse filler before the name.
  coolDown();
  const fillerAddressed = await say('so Cinderella what can you do');
  check('a leading "so" no longer breaks addressing', fillerAddressed.handled);
  coolDown();
  const stillNotAddressed = await say(
    'I was thinking that Cinderella might be a good name for this whole thing honestly',
  );
  check(
    'but a sentence merely containing her name is still not an address',
    !stillNotAddressed.handled && stillNotAddressed.replies.length === 0,
  );

  // §7c — carry-over inside the follow-up window, and its consent guard.
  coolDown();
  await clearConsent(ALICE);
  await say('Cinderella what can you do');
  clock.advanceSeconds(5);
  // Seed the remembered intent the way a real price answer would.
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  priceAsked.length = 0;
  const elliptical = await say('monero?');
  check(
    'an elliptical follow-up inherits the previous read-only intent',
    elliptical.handled && priceAsked.includes('monero'),
    elliptical.replies[0]?.slice(0, 40),
  );

  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  const elliptical2 = await say('and of monero?');
  check('filler is stripped from the follow-up too', elliptical2.handled);

  /* ── CCB-S3-008 §1 — carry-over may reuse knowledge, never create it ────── */

  // The live defect, verbatim: after two price answers a member wrote this, and
  // she offered "Nice" and "Bury Nice Token" as assets to choose between.
  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  priceAsked.length = 0;
  const applause = await say('nice :)))))))');
  check(
    'an interjection after a price answer produces NO reply',
    !applause.handled && applause.replies.length === 0,
    applause.replies[0]?.slice(0, 60),
  );
  check('and never reaches a provider at all', priceAsked.length === 0);

  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  const cool = await say('cool');
  check('"cool" is silence too', !cool.handled && cool.replies.length === 0);

  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  const smiley = await say(':)))))))');
  check(
    'a message with no letters at all never carries over',
    !smiley.handled && smiley.replies.length === 0,
  );

  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  priceAsked.length = 0;
  const unknownWord = await say('quux?');
  check(
    'an UNPINNED word is silence, never a disambiguation',
    !unknownWord.handled && unknownWord.replies.length === 0,
    unknownWord.replies[0]?.slice(0, 60),
  );
  check('and no resolution was started for it', priceAsked.length === 0);

  // The rule is about knowledge, not about the word: pin it, and it carries.
  pinned.add('QUUX');
  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  priceAsked.length = 0;
  const nowKnown = await say('quux?');
  check(
    'once pinned, the same fragment does carry over',
    nowKnown.handled && priceAsked.includes('quux'),
  );
  pinned.delete('QUUX');

  check(
    'settings: the stop-list ships with the words seen in the live group',
    DEFAULT_INTERACTION.carryOverStopWords.includes('nice') &&
      DEFAULT_INTERACTION.carryOverStopWords.includes('danke'),
  );

  // The structural guard: carry-over must NEVER produce a consent action.
  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  const bareMe = await say('me?');
  check(
    'a bare "me?" after a price answer performs no consent action',
    (await consentRow(ALICE)).optedIn === false,
  );
  check('and does not produce a confirmation prompt', !bareMe.replies[0]?.includes('Say *yes*'));

  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  const yesPlease = await say('yes please');
  check(
    'nor does "yes please"',
    (await consentRow(ALICE)).optedIn === false &&
      !yesPlease.replies[0]?.includes('shine in the public archive'),
  );

  // Carry-over is switchable.
  settings = normalizeInteraction({ ...settings, intentCarryover: false });
  coolDown();
  await say('Cinderella what can you do');
  clock.advanceSeconds(5);
  engine.rememberIntentForTest(GROUP, ALICE, 'PRICE');
  const noCarry = await say('monero?');
  check('carry-over can be switched off', !noCarry.handled && noCarry.replies.length === 0);
  settings = normalizeInteraction({});

  check(
    'settings: the CCB-S3-006 defaults',
    DEFAULT_INTERACTION.intentCarryover === true &&
      DEFAULT_INTERACTION.fillerPrefixes.includes('so') &&
      DEFAULT_INTERACTION.maxPrefixWords === 3,
  );

  /* ── 15. Capture pipeline integration ──────────────────────────────────── */

  section('15. Capture pipeline — instructions are not archived');

  settings = normalizeInteraction({});
  coolDown();

  const handlers = new Map<string, (ev: unknown) => Promise<void>>();
  const fakeBot = {
    chat: {
      on(event: string, handler: (ev: unknown) => Promise<void>) {
        handlers.set(event, handler);
      },
    },
  } as unknown as BotHandle;

  const persisted: string[] = [];
  let commandsSeen = 0;
  const hooks: CaptureHooks = {
    onMessage: (m) => {
      persisted.push(m.text);
    },
    onCommand: () => {
      commandsSeen++;
    },
    onInteraction: (m) => engine.handle(m),
    isAddressed: (m) => engine.isExplicitAddress(m),
  };

  let slashEnabled = true;
  registerCapture(fakeBot, { groupName: undefined } as Config, hooks, {
    targetGroupId: GROUP,
    slashCommandsEnabled: () => slashEnabled,
  });

  let chatItemId = 2000;
  function aChatItem(text: string): T.AChatItem {
    return {
      chatInfo: { type: 'group', groupInfo: { groupId: GROUP, localDisplayName: 'archive' } },
      chatItem: {
        chatDir: {
          type: 'groupRcv',
          groupMember: {
            memberId: ALICE,
            memberProfile: { displayName: 'Alice' },
            localDisplayName: 'Alice',
          },
        },
        meta: { itemId: chatItemId++, itemTs: clock.iso() },
        content: { type: 'rcvMsgContent', msgContent: { type: 'text', text } },
      },
    } as unknown as T.AChatItem;
  }

  const deliver = async (text: string): Promise<void> => {
    const handler = handlers.get('newChatItems');
    if (handler) await handler({ chatItems: [aChatItem(text)] });
  };

  await clearConsent(ALICE);
  await deliver('hello everyone, nice weather today');
  await deliver('Cinderella publish me');
  await deliver('I think Cinderella is great');

  check(
    'ordinary group chatter is archived',
    persisted.includes('hello everyone, nice weather today'),
  );
  // REVERSED BY CCB-S3-009, deliberately. This used to assert that an
  // instruction was dropped. That was right while an instruction meant
  // `/publish`; once natural addressing made a price question an instruction it
  // meant every question a member asked her vanished, and the public archive
  // showed her answers with nothing above them. A member's question is that
  // member's message — it is archived, and its CATEGORY decides publication.
  check('an instruction to her IS archived now', persisted.includes('Cinderella publish me'));
  check(
    'talking about her IS archived (it is ordinary conversation)',
    persisted.includes('I think Cinderella is great'),
  );

  await deliver('/publish');
  check('slash commands still reach the consent handler', commandsSeen === 1);
  check(
    'and ARE archived, under the consent category, which ships excluded',
    persisted.includes('/publish'),
  );

  // The follow-up window from `Cinderella publish me` above is still open here,
  // which is exactly the case worth testing: a disabled slash command must not
  // come back in through the conversational route.
  slashEnabled = false;
  await deliver('/publish');
  check('with slash commands off the handler is not called again', commandsSeen === 1);
  check(
    'and the command does not sneak in as natural language — it is archived as ordinary text',
    persisted.includes('/publish'),
  );

  /* -- 19. CCB-S3-010 -- help, and the promises stated before consent ---- */

  section('19. CCB-S3-010 -- help from the active catalog, and true prompt copy');

  settings = normalizeInteraction({});
  coolDown();

  for (const phrasing of [
    'Cinderella help',
    'Cinderella what can you do',
    'Cinderella can you help me',
    'Cinderella what do you do',
    'Cinderella who are you',
    'Cinderella how does this work',
    'Cinderella commands',
    'Cinderella was kannst du',
    'Cinderella kannst du mir helfen',
    'Cinderella wie funktioniert das',
    'Cinderella wer bist du',
  ]) {
    coolDown();
    const r = await say(phrasing);
    check(
      `"${phrasing}" is understood as help`,
      r.handled && /Cinderella|archive|Archiv/.test(r.replies[0] ?? ''),
    );
  }

  coolDown();
  const slashHelp = await say('/help');
  check(
    'the bare /help slash is answered',
    slashHelp.handled && (slashHelp.replies[0]?.length ?? 0) > 100,
  );

  coolDown();
  const helpText = (await say('Cinderella help')).replies[0] ?? '';
  check('help states forward-only', /forward only/i.test(helpText));
  check('help states public-until-revoked', /public until/i.test(helpText));
  check('help states revocation is final', /final/i.test(helpText) && /does not bring/i.test(helpText));
  check('help lists PRICE while the plugin is enabled here', /price/i.test(helpText));

  setActiveIntents([]);
  coolDown();
  const helpNoPrice = (await say('Cinderella help')).replies[0] ?? '';
  check('a disabled plugin drops out of the help text', !/price of/i.test(helpNoPrice));
  check(
    'and the core capabilities remain',
    /publish/i.test(helpNoPrice) && /unpublish/i.test(helpNoPrice),
  );
  setActiveIntents(['PRICE']);

  coolDown();
  const topicHelp = (await say('Cinderella help consent')).replies[0] ?? '';
  check(
    'help consent gives the fuller consent explanation',
    /Publishing, in full|one thing I cannot undo/i.test(topicHelp),
  );

  coolDown();
  const pubPrompt = (await say('Cinderella publish me')).replies[0] ?? '';
  check(
    'the publish prompt states forward-only',
    /from this moment on|never anything from before/i.test(pubPrompt),
  );
  check('and that taking it back is final', /final|no bringing it back/i.test(pubPrompt));

  coolDown();
  const unpubPrompt = (await say('Cinderella unpublish me')).replies[0] ?? '';
  check('the unpublish prompt warns it cannot be undone', /cannot be undone/i.test(unpubPrompt));
  check(
    'and does NOT mention hide or restore (a later briefing owns that)',
    !/\bhide\b|\brestore\b/i.test(unpubPrompt),
  );

  settings = normalizeInteraction({ archiveUrl: 'https://example.org/archive' });
  coolDown();
  const withLink = (await say('Cinderella help')).replies[0] ?? '';
  check(
    'a configured archive link appears in help',
    withLink.includes('https://example.org/archive'),
  );
  settings = normalizeInteraction({ archiveUrl: 'http://insecure.example' });
  check('a non-https link is rejected at normalize time', settings.archiveUrl === '');
  settings = normalizeInteraction({});

  /* -- 20. CCB-S3-021 §3 -- the help reply is a genuinely editable template -- */
  section('20. CCB-S3-021 -- help is an editable template, validated, blank restores default');

  // Editing the help template changes what she actually replies.
  settings = normalizeInteraction({
    persona: { en: { help: 'CUSTOM HEADER for {wake}.\n\n{consent}\n\n{commands}' } },
  });
  coolDown();
  const customHelp = (await say('Cinderella help')).replies[0] ?? '';
  check('editing the help template changes the reply', /CUSTOM HEADER for Cinderella\./.test(customHelp));
  check('the generated command list still fills the {commands} slot', /\*publish\*/i.test(customHelp));
  check('the publishing properties still fill the {consent} slot', /forward only/i.test(customHelp));

  // Blanking the field restores the shipped default.
  settings = normalizeInteraction({ persona: { en: { help: '' } } });
  coolDown();
  const blankHelp = (await say('Cinderella help')).replies[0] ?? '';
  check(
    'blanking the help field restores the default',
    /I am \*Cinderella\*/.test(blankHelp) && /What you can ask me/i.test(blankHelp),
  );

  // A pre-CCB-S3-021 stored one-liner (no {commands}/{consent}) must not render a
  // help missing its command list or properties: normalize falls back to default.
  settings = normalizeInteraction({ persona: { en: { help: '🕯️ Say "{wake}, publish me".' } } });
  coolDown();
  const staleHelp = (await say('Cinderella help')).replies[0] ?? '';
  check(
    'a stale help template without placeholders restores the default',
    /What you can ask me/i.test(staleHelp) && /forward only/i.test(staleHelp) && /\*publish\*/i.test(staleHelp),
  );

  // Validation (the admin uses this to reject a broken save): a non-blank template
  // must keep {commands} and {consent}; a blank one is fine (restores the default).
  check('a template missing {commands} is rejected', missingHelpPlaceholders('only {consent}').includes('{commands}'));
  check('a template missing {consent} is rejected', missingHelpPlaceholders('only {commands}').includes('{consent}'));
  check('a complete template validates', missingHelpPlaceholders('{commands} {consent}').length === 0);
  check('a blank template validates (it restores the default)', missingHelpPlaceholders('').length === 0);
  settings = normalizeInteraction({});

  /* -- 21. CCB-S3-005 Addendum A -- a matched keyword set decides the language -- */
  section('21. CCB-S3-005 Addendum A -- short instructions answered in the language written');
  settings = normalizeInteraction({});
  const isGerman = (r: string): boolean => /Ich bin \*Cinderella\*/.test(r);
  const isEnglish = (r: string): boolean => /I am \*Cinderella\*/.test(r);

  coolDown();
  const helpDe = (await say('Cinderella Hilfe')).replies[0] ?? '';
  check('"Cinderella Hilfe" is answered in German (the bug this fixes)', isGerman(helpDe));
  coolDown();
  const helpEn = (await say('Cinderella help')).replies[0] ?? '';
  check('"Cinderella help" is answered in English', isEnglish(helpEn));
  coolDown();
  const wasKannst = (await say('Cinderella was kannst du')).replies[0] ?? '';
  check('"Cinderella was kannst du" is answered in German', isGerman(wasKannst));
  coolDown();
  const wieFunk = (await say('Cinderella wie funktioniert das')).replies[0] ?? '';
  check('"Cinderella wie funktioniert das" is answered in German', isGerman(wieFunk));

  // A keyword identical in both languages (status, undo) is ambiguous: it must NOT
  // be treated as authoritative, so it falls to the contest and then the default.
  coolDown();
  const statusAmbiguous = (await say('Cinderella status')).replies[0] ?? '';
  check(
    'an identical-in-both keyword (status) falls to the contest + default, not a coin-flip',
    /I keep/i.test(statusAmbiguous),
  );
  settings = normalizeInteraction({});

  console.log(
    `\n${failures === 0 ? 'All interaction checks passed.' : `${failures} check(s) FAILED.`}`,
  );
  await pg.close();
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
