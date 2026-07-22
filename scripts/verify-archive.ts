/**
 * CCB-S3-007 verification harness — Cinderella's own messages in the archive.
 *
 * Runs the REAL migrations and the REAL write path against PGlite (Postgres in
 * WASM), because the whole feature is a change to the publication derivation and
 * a derivation is only as true as the database says it is.
 *
 * What it is actually trying to prove, in order of how much it would cost to be
 * wrong about:
 *
 *   1. A member's consent still means exactly what it meant, and no row was
 *      invented for the bot to ride on.
 *   2. A reply naming somebody who has not opted in cannot publish that name —
 *      not on the page, not through search, and not after the fact when they
 *      change their mind.
 *   3. The switches do what they say, in both directions, with nothing stale
 *      left behind.
 *
 *   npx tsx scripts/verify-archive.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { upsertMessage } from '../src/db/messages.js';
import { recordOptIn, recordOptOut } from '../src/db/consent.js';
import { insertBotMessage, resolveMemberByDisplayName } from '../src/db/bot-messages.js';
import { recordBotReply } from '../src/capture/bot-message.js';
import { redactNames } from '../src/archive/redact.js';
import {
  DEFAULT_ARCHIVE,
  REPLY_CATEGORIES,
  normalizeArchive,
  type ArchiveSettings,
} from '../src/archive/settings.js';
import { PERSONA_CATEGORY, PERSONA_KEYS, DEFAULT_INTERACTION } from '../src/interaction/settings.js';
import { setSetting } from '../src/db/settings.js';
import { listPublishedItems, countPublishedMatching } from '../src/db/public-archive.js';
import type { Queryable } from '../src/db/pool.js';
import type { T } from '@simplex-chat/types';

let failures = 0;
function section(title: string): void {
  console.log(`\n${title}`);
}
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const GROUP = 1;
const BOT = 'member-cinderella';
const ALICE = 'member-alice';
const ROBIN = 'member-robin';

const ALL_TYPES = ['text', 'image', 'video', 'voice', 'link', 'file'] as const;

async function main(): Promise<void> {
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

  let nextItemId = 100;
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 12, n)).toISOString();

  /** A member's own message. */
  async function memberSays(member: string, text: string, minute: number): Promise<number> {
    return upsertMessage(db, {
      groupId: GROUP,
      groupMsgId: nextItemId++,
      sharedMsgId: null,
      senderMemberId: member,
      senderDisplayName: member === ALICE ? 'Alice' : 'Robin',
      sentAt: at(minute),
      type: 'text',
      textBody: text,
      linksText: null,
      rawJson: {},
    });
  }

  /** One of hers, written exactly the way the running bot writes it. */
  async function sheSays(
    text: string,
    opts: {
      category: (typeof REPLY_CATEGORIES)[number] | null;
      minute: number;
      mentions?: { displayName: string; memberId?: string }[];
      lang?: string;
    },
  ): Promise<number> {
    const itemId = nextItemId++;
    // The shape the SDK actually returns from apiSendTextMessage.
    const sent = [
      {
        chatInfo: {
          type: 'group',
          groupInfo: {
            groupId: GROUP,
            localDisplayName: 'archive',
            membership: { memberId: BOT, memberProfile: { displayName: 'Cinderella' } },
          },
        },
        chatItem: {
          chatDir: { type: 'groupSnd' },
          meta: { itemId, itemTs: at(opts.minute), itemSharedMsgId: null },
          content: { type: 'sndMsgContent' },
        },
      } as unknown as T.AChatItem,
    ];
    await recordBotReply(
      db,
      sent,
      text,
      {
        category: opts.category,
        lang: opts.lang ?? 'en',
        ...(opts.mentions ? { mentions: opts.mentions } : {}),
      },
      DEFAULT_INTERACTION.persona['en']?.redactedMember ?? 'that member',
    );
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM messages WHERE group_id = $1 AND group_msg_id = $2',
      [GROUP, itemId],
    );
    return Number(rows[0]?.id);
  }

  const published = async (id: number): Promise<boolean> => {
    const { rows } = await db.query<{ published: boolean }>(
      'SELECT published FROM message_publish_state WHERE id = $1',
      [id],
    );
    return rows[0]?.published === true;
  };
  const publicText = async (id: number): Promise<string | null> => {
    const { rows } = await db.query<{ text_body: string | null }>(
      'SELECT text_body FROM published_messages WHERE id = $1',
      [id],
    );
    return rows[0]?.text_body ?? null;
  };
  const saveArchive = (patch: Partial<ArchiveSettings>): Promise<void> =>
    setSetting(db, 'archive', normalizeArchive({ ...DEFAULT_ARCHIVE, ...patch }));

  /* ── 1. Consent is untouched ─────────────────────────────────────────────── */

  section('1. Consent keeps its old meaning');

  await recordOptIn(db, ALICE, at(0));
  const aliceMsg = await memberSays(ALICE, 'hello everyone', 1);
  const robinMsg = await memberSays(ROBIN, 'hello back', 1);

  check('an opted-in member still publishes', await published(aliceMsg));
  check('a member who never opted in still does not', !(await published(robinMsg)));

  const herFirst = await sheSays('1 BTC is 60000 USD.', { category: 'price', minute: 2 });
  check('her own message publishes without any consent row', await published(herFirst));

  const { rows: consentRows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM consent WHERE member_id = $1',
    [BOT],
  );
  check('and NO consent row was invented for her', consentRows[0]?.n === 0);

  const { rows: allConsent } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM consent',
  );
  check('the consent table holds exactly the one real member', allConsent[0]?.n === 1);

  /* ── 2. The master switch, in both directions ────────────────────────────── */

  section('2. publish_bot_messages, both ways');

  await saveArchive({ publishBotMessages: false });
  check('off removes her messages from the stream', !(await published(herFirst)));
  check('and leaves members untouched', await published(aliceMsg));

  await saveArchive({ publishBotMessages: true });
  check('on brings them back — nothing stale was stored', await published(herFirst));

  const page = await listPublishedItems(db, ALL_TYPES, { page: 1, pageSize: 20 });
  const senders = page.items.map((i) => i.senderDisplayName);
  check(
    'the public stream reads as a conversation, not one side of one',
    senders.includes('Alice') && senders.includes('Cinderella'),
    senders.join(' + '),
  );

  /* ── 3. The leak guard, all three cases ──────────────────────────────────── */

  section('3. The leak guard');

  const refusal = await sheSays('🕯️ Only Robin may open that door.', {
    category: 'consent',
    minute: 3,
    mentions: [{ displayName: 'Robin' }],
  });

  check('CASE 1 — names a member who has NOT opted in: redacted',
    (await publicText(refusal)) === '🕯️ Only that member may open that door.',
    String(await publicText(refusal)),
  );
  check('the message itself still publishes (redact, not withhold)', await published(refusal));

  await recordOptIn(db, ROBIN, at(0));
  check(
    'CASE 2 — names a member who HAS opted in: published unchanged',
    (await publicText(refusal)) === '🕯️ Only Robin may open that door.',
    String(await publicText(refusal)),
  );

  await recordOptOut(db, ROBIN, at(4));
  check(
    'CASE 3 — RETROACTIVE: they unpublish, and her older message redacts again',
    (await publicText(refusal)) === '🕯️ Only that member may open that door.',
    String(await publicText(refusal)),
  );

  check(
    'search cannot find the name through her words either',
    (await countPublishedMatching(db, 'Robin')) === 0,
  );
  check(
    'but her message is still findable by its own content',
    (await countPublishedMatching(db, 'door')) === 1,
  );

  await saveArchive({ mentionGuard: 'withhold' });
  check('withhold suppresses the whole message instead', !(await published(refusal)));
  await saveArchive({ mentionGuard: 'redact' });

  // A name that cannot be tied to a member has no consent to point at.
  const stranger = await sheSays('🕯️ Only Mallory may open that door.', {
    category: 'consent',
    minute: 5,
    mentions: [{ displayName: 'Mallory' }],
  });
  check(
    'an UNRESOLVABLE name is treated as non-consenting',
    (await publicText(stranger))?.includes('that member') === true,
    String(await publicText(stranger)),
  );

  /* ── 4. Categories ───────────────────────────────────────────────────────── */

  section('4. Category filters');

  const ids: Record<string, number> = {};
  let minute = 10;
  for (const c of REPLY_CATEGORIES) {
    ids[c] = await sheSays(`a ${c} reply`, { category: c, minute: minute++ });
  }
  const unclassified = await sheSays('a reply nobody classified', {
    category: null,
    minute: minute++,
  });

  for (const c of REPLY_CATEGORIES) {
    check(
      `default for "${c}" is ${DEFAULT_ARCHIVE.categories[c] ? 'publish' : 'exclude'}`,
      (await published(ids[c] as number)) === DEFAULT_ARCHIVE.categories[c],
    );
  }
  check('an UNCLASSIFIED reply is never published (fails safe)', !(await published(unclassified)));

  await saveArchive({ categories: { ...DEFAULT_ARCHIVE.categories, nickname: true } });
  check('an exclusion is switchable back on', await published(ids['nickname'] as number));
  await saveArchive({ categories: { ...DEFAULT_ARCHIVE.categories, price: false } });
  check('and a published category is switchable off', !(await published(ids['price'] as number)));
  await saveArchive({});

  check(
    'every persona string she can say has a category (compile-time total, checked here too)',
    PERSONA_KEYS.every((k) => REPLY_CATEGORIES.includes(PERSONA_CATEGORY[k])),
  );

  /* ── 5. The SQL defaults match the TypeScript defaults ───────────────────── */

  section('5. The two copies of the defaults agree');

  await db.query('DELETE FROM settings WHERE key = $1', ['archive']);
  const { rows: sqlDefaults } = await db.query<{
    publish_bot: boolean;
    mention_guard: string;
    categories: Record<string, boolean> | string;
  }>('SELECT * FROM bot_publish_settings');
  const cats =
    typeof sqlDefaults[0]?.categories === 'string'
      ? (JSON.parse(sqlDefaults[0].categories) as Record<string, boolean>)
      : ((sqlDefaults[0]?.categories ?? {}) as Record<string, boolean>);

  check(
    'publishBotMessages default agrees',
    sqlDefaults[0]?.publish_bot === DEFAULT_ARCHIVE.publishBotMessages,
  );
  check('mentionGuard default agrees', sqlDefaults[0]?.mention_guard === DEFAULT_ARCHIVE.mentionGuard);
  for (const c of REPLY_CATEGORIES) {
    check(`category default for "${c}" agrees`, cats[c] === DEFAULT_ARCHIVE.categories[c]);
  }

  /* ── 6. Hostile input must not break the archive ─────────────────────────── */

  section('6. Hostile and malformed input');

  await setSetting(db, 'archive', { publishBotMessages: 'maybe', categories: 42 });
  const { rows: survived } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM published_messages',
  );
  check(
    'a malformed settings value does not take the public archive down',
    survived[0] !== undefined && survived[0].n > 0,
    `${survived[0]?.n ?? 0} rows still published`,
  );
  await db.query('DELETE FROM settings WHERE key = $1', ['archive']);

  // A display name is member-controlled, and it is fed to a regex.
  await memberSays(ROBIN, 'placeholder', 6);
  await db.query('UPDATE messages SET sender_display_name = $1 WHERE sender_member_id = $2', [
    'Ro[b]in.*',
    ROBIN,
  ]);
  const metaName = await sheSays('🕯️ Only Ro[b]in.* may pass, nobody else.', {
    category: 'consent',
    minute: 7,
    mentions: [{ displayName: 'Ro[b]in.*' }],
  });
  check(
    'a display name full of regex metacharacters is matched literally',
    (await publicText(metaName)) === '🕯️ Only that member may pass, nobody else.',
    String(await publicText(metaName)),
  );

  // The placeholder is operator-editable and lands in a regexp replacement slot,
  // where a backslash would be a back-reference to the matched text.
  await setSetting(db, 'interaction', {
    ...DEFAULT_INTERACTION,
    persona: {
      ...DEFAULT_INTERACTION.persona,
      en: { ...DEFAULT_INTERACTION.persona['en'], redactedMember: 'a \\& member' },
    },
  });
  const hostilePlaceholder = await publicText(metaName);
  check(
    'a backslash in the placeholder cannot re-emit the redacted name',
    hostilePlaceholder !== null && !hostilePlaceholder.includes('Ro[b]in'),
    String(hostilePlaceholder),
  );
  await db.query('DELETE FROM settings WHERE key = $1', ['interaction']);

  // A name that is a substring of an ordinary word.
  check(
    'redaction is word-anchored: "Ann" does not eat "Anna" or "planned"',
    redactNames('Anna planned it; Ann spoke.', ['Ann'], '[X]') === 'Anna planned it; [X] spoke.',
    redactNames('Anna planned it; Ann spoke.', ['Ann'], '[X]'),
  );
  check(
    'but it does catch a name against punctuation',
    redactNames("Robin's turn, Robin!", ['Robin'], '[X]') === "[X]'s turn, [X]!",
    redactNames("Robin's turn, Robin!", ['Robin'], '[X]'),
  );
  check(
    'and a non-ASCII name is not split mid-word',
    redactNames('Åsa and Åsalen spoke.', ['Åsa'], '[X]') === '[X] and Åsalen spoke.',
    redactNames('Åsa and Åsalen spoke.', ['Åsa'], '[X]'),
  );
  check(
    'an empty name cannot match everywhere',
    redactNames('Bob said hi.', ['', 'Bob'], '[X]') === '[X] said hi.',
    redactNames('Bob said hi.', ['', 'Bob'], '[X]'),
  );

  /* ── 7. Structural guarantees ────────────────────────────────────────────── */

  section('7. Structure');

  const { rows: cols } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'published_messages'`,
  );
  const names = cols.map((c) => c.column_name);
  check(
    'published_messages does NOT expose raw_json (it holds quoted member text)',
    !names.includes('raw_json'),
  );
  check('but still exposes what the public readers need',
    ['id', 'sender_display_name', 'sent_at', 'type', 'text_body', 'media_path', 'search',
     'sender_member_id'].every((c) => names.includes(c)),
  );

  // Her rows are indexed by search_body ALONE, so a missing one hides the row
  // rather than quietly indexing the unredacted reply.
  let checkHeld = false;
  try {
    await db.query(
      `INSERT INTO messages (group_id, group_msg_id, sender_member_id, sender_display_name,
         sent_at, type, text_body, raw_json, is_bot, bot_category)
       VALUES ($1, $2, $3, 'Cinderella', $4, 'text', 'unindexed', '{}'::jsonb, TRUE, 'price')`,
      [GROUP, nextItemId++, BOT, at(20)],
    );
  } catch {
    checkHeld = true;
  }
  check('a bot row without search_body is rejected outright', checkHeld);

  check(
    'an ambiguous display name resolves to nobody (and so stays redacted)',
    (await (async (): Promise<string | null> => {
      await memberSays(ALICE, 'x', 8);
      await db.query(
        `INSERT INTO messages (group_id, group_msg_id, sender_member_id, sender_display_name,
           sent_at, type, text_body, raw_json)
         VALUES ($1, $2, 'member-other', 'Alice', $3, 'text', 'y', '{}'::jsonb)`,
        [GROUP, nextItemId++, at(9)],
      );
      return resolveMemberByDisplayName(db, 'Alice');
    })()) === null,
  );

  const { rows: mentionRows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM message_mentions WHERE message_id = $1',
    [refusal],
  );
  check('mentions are recorded once, not appended on retry', mentionRows[0]?.n === 1);
  await insertBotMessage(db, {
    groupId: GROUP,
    groupMsgId: 103,
    sharedMsgId: null,
    senderMemberId: BOT,
    senderDisplayName: 'Cinderella',
    sentAt: at(3),
    text: '🕯️ Only Robin may open that door.',
    category: 'consent',
    lang: 'en',
    searchBody: '🕯️ Only that member may open that door.',
    mentions: [{ memberId: null, displayName: 'Robin' }],
    rawJson: {},
  });
  const { rows: afterRetry } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM message_mentions WHERE message_id = $1',
    [refusal],
  );
  check('a re-send of the same item does not duplicate them', afterRetry[0]?.n === 1);

  console.log(
    failures === 0
      ? '\nAll CCB-S3-007 archive checks passed.'
      : `\n${failures} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
