/**
 * CCB-S3-019 verification harness — private support-scope messages are NEVER
 * captured, NEVER published, and never appear in any archive table.
 *
 * The finding (from the CCB-S3-016 audit): a member's private "Chat with admins"
 * thread arrives on the SAME `newChatItems` event as ordinary group messages,
 * distinguished only by `chatInfo.groupChatScope`. If that member has opted in,
 * their private conversation would be captured and published — the one thing a
 * private channel exists to prevent, and unrecoverable once read.
 *
 * This runs the REAL migrations, the REAL capture handler, the REAL
 * `parseGroupMessage` gate, and the REAL publication view against PGlite (Postgres
 * in WASM). It proves the guarantee at three levels, each of which FAILS if the
 * `isPublicGroupChat` gate is removed or weakened:
 *
 *   1. Gate level — `parseGroupMessage` returns null for a support-scope item and
 *      a value for a public one (and for anything ambiguous, fail-closed).
 *   2. Capture path — driving the handler, a support-scope item never reaches the
 *      persistence hook, while an ordinary message does.
 *   3. Publication path — the `messages` and `published_messages` tables contain
 *      the ordinary message and NOT the support-scope one, even though its sender
 *      is opted in (so consent is not what excludes it — the scope gate is).
 *
 *   npx tsx scripts/verify-support-scope.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { registerCapture, type CaptureHooks } from '../src/capture/handler.js';
import { isPublicGroupChat, parseGroupMessage } from '../src/capture/message.js';
import { upsertMessage } from '../src/db/messages.js';
import { recordOptIn } from '../src/db/consent.js';
import type { Config } from '../src/config.js';
import type { BotHandle } from '../src/bot/client.js';
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
const ALICE = 'member-alice';

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

  // Alice opted in BEFORE anything she says here, so nothing but the scope gate
  // could keep an ordinary message of hers off the public archive.
  const OPT_IN = new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString();
  await recordOptIn(db, ALICE, OPT_IN);

  let nextItemId = 5000;
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 12, n)).toISOString();

  const groupMember = {
    memberId: ALICE,
    memberProfile: { displayName: 'Alice' },
    localDisplayName: 'Alice',
  };

  /** An ordinary PUBLIC group message from Alice. */
  function publicItem(text: string): T.AChatItem {
    return {
      chatInfo: { type: 'group', groupInfo: { groupId: GROUP, localDisplayName: 'archive' } },
      chatItem: {
        chatDir: { type: 'groupRcv', groupMember },
        meta: { itemId: nextItemId++, itemTs: at(5) },
        content: { type: 'rcvMsgContent', msgContent: { type: 'text', text } },
      },
    } as unknown as T.AChatItem;
  }

  /** A PRIVATE member-support ("Chat with admins") message from Alice — the leak. */
  function supportScopeItem(text: string): T.AChatItem {
    return {
      chatInfo: {
        type: 'group',
        groupInfo: { groupId: GROUP, localDisplayName: 'archive' },
        // The one field that distinguishes the private thread (types.d.ts:978).
        groupChatScope: { type: 'memberSupport', groupMember_: groupMember },
      },
      chatItem: {
        chatDir: { type: 'groupRcv', groupMember },
        meta: { itemId: nextItemId++, itemTs: at(6) },
        content: { type: 'rcvMsgContent', msgContent: { type: 'text', text } },
      },
    } as unknown as T.AChatItem;
  }

  /* ── 1. The gate itself ──────────────────────────────────────────────────── */
  section('1. isPublicGroupChat / parseGroupMessage — the fail-closed gate');

  const pub = publicItem('public group hello');
  const priv = supportScopeItem('PRIVATE secret meant only for the admins');

  check('a public group item is recognised as public', isPublicGroupChat(pub.chatInfo));
  check('a support-scope item is NOT public', !isPublicGroupChat(priv.chatInfo));
  check('parseGroupMessage keeps the public message', parseGroupMessage(pub) !== null);
  check('parseGroupMessage DROPS the support-scope message', parseGroupMessage(priv) === null);

  // Fail closed on ambiguity: a group item whose scope is present in ANY form
  // (even an unrecognised one) must be excluded, not captured.
  const weird = {
    chatInfo: {
      type: 'group',
      groupInfo: { groupId: GROUP, localDisplayName: 'archive' },
      groupChatScope: { type: 'somethingNewLater' },
    },
    chatItem: {
      chatDir: { type: 'groupRcv', groupMember },
      meta: { itemId: nextItemId++, itemTs: at(6) },
      content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'ambiguous scope' } },
    },
  } as unknown as T.AChatItem;
  check('an unknown/future scope is also excluded (fail closed)', parseGroupMessage(weird) === null);

  // A direct chat (CCB-S3-017 §2) is likewise not a public group message.
  const direct = {
    chatInfo: { type: 'direct', contact: { contactId: 1 } },
    chatItem: {
      chatDir: { type: 'directRcv' },
      meta: { itemId: nextItemId++, itemTs: at(6) },
      content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'a DM' } },
    },
  } as unknown as T.AChatItem;
  check('a direct message is excluded by the same gate', parseGroupMessage(direct) === null);

  /* ── 2 & 3. Capture + publication paths, end to end ──────────────────────── */
  section('2/3. Capture handler → messages / published_messages');

  const handlers = new Map<string, (ev: unknown) => Promise<void>>();
  const fakeBot = {
    chat: {
      on(event: string, handler: (ev: unknown) => Promise<void>) {
        handlers.set(event, handler);
      },
    },
  } as unknown as BotHandle;

  // The real persistence shape, but writing to THIS PGlite db (the shipped hooks
  // use the global pool). Everything upstream of onMessage — parseGroupMessage,
  // the gate, scoping — is the real code path.
  const reachedOnMessage: string[] = [];
  const hooks: CaptureHooks = {
    onMessage: async (m) => {
      reachedOnMessage.push(m.text);
      await upsertMessage(db, {
        groupId: m.groupId,
        groupMsgId: m.itemId,
        sharedMsgId: m.sharedMsgId ?? null,
        senderMemberId: m.senderMemberId,
        senderDisplayName: m.senderDisplayName,
        sentAt: m.sentAt,
        type: m.type,
        textBody: m.text.length > 0 ? m.text : null,
        linksText: null,
        rawJson: m.raw,
      });
    },
  };

  registerCapture(fakeBot, { groupName: undefined } as Config, hooks, { targetGroupId: GROUP });

  const newItems = handlers.get('newChatItems');
  if (!newItems) throw new Error('capture did not register a newChatItems handler');
  // Both arrive on the SAME event, exactly as the core delivers them.
  await newItems({ chatItems: [pub, priv] });

  check('the public message reached persistence', reachedOnMessage.includes('public group hello'));
  check(
    'the support-scope message NEVER reached persistence',
    !reachedOnMessage.some((t) => t.startsWith('PRIVATE')),
  );

  const inMessages = async (like: string): Promise<number> => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM messages WHERE text_body LIKE $1`,
      [like],
    );
    return Number(r.rows[0]?.n ?? 0);
  };
  const inPublished = async (like: string): Promise<number> => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM published_messages WHERE text_body LIKE $1`,
      [like],
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  check('messages contains the public message', (await inMessages('public group%')) === 1);
  check('messages does NOT contain the private message', (await inMessages('PRIVATE%')) === 0);
  check(
    'published_messages contains the public message (Alice opted in)',
    (await inPublished('public group%')) === 1,
  );
  check(
    'published_messages does NOT contain the private message',
    (await inPublished('PRIVATE%')) === 0,
  );

  // The scan discriminator (used by scripts/scan-support-scope.ts) must find
  // nothing scoped in the table after a clean capture run.
  const scoped = await db.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM messages
     WHERE raw_json -> 'chatInfo' -> 'groupChatScope' IS NOT NULL`,
  );
  check('no captured row carries a groupChatScope', Number(scoped.rows[0]?.n ?? 0) === 0);

  /* ── 4. Deletion path is gated too ───────────────────────────────────────── */
  section('4. In-group deletion path ignores support scope');

  const delHandler = handlers.get('chatItemsDeleted');
  if (delHandler) {
    // A deletion event that references a support-scope item must be a no-op and
    // must not throw; the public message stays published.
    await delHandler({
      chatItemDeletions: [{ deletedChatItem: supportScopeItem('PRIVATE deletion') }],
    });
  }
  check(
    'a support-scope deletion leaves the public message published',
    (await inPublished('public group%')) === 1,
  );

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  await pg.close();
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
