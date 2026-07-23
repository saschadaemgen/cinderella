/**
 * Stage 3 verification harness — consent gating.
 *
 * Exercises the REAL consent write-path (recordOptIn / recordOptOut),
 * markDeleted, and the derived publish views against PGlite, asserting the
 * Stage 3 acceptance (briefing §5):
 *   - before /publish a member's rows are unpublished;
 *   - after /publish their later messages are published, earlier ones are not
 *     (forward-only from opt-in);
 *   - after /unpublish none of their rows are published;
 *   - re-opt-in is forward-only from the new opt-in;
 *   - deleting a message flips it out of the published set.
 *
 *   npx tsx scripts/verify-consent.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { markDeleted, upsertMessage } from '../src/db/messages.js';
import { recordOptIn, recordOptOut } from '../src/db/consent.js';
import { parseConsentCommand } from '../src/consent/commands.js';
import type { Queryable } from '../src/db/pool.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const GROUP_ID = 1;
const A = 'member-alice';
const B = 'member-bob';

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

  // Insert a message from `member` at `sentAt` with group_msg_id `id`.
  async function insert(member: string, id: number, sentAt: string): Promise<void> {
    await upsertMessage(db, {
      groupId: GROUP_ID,
      groupMsgId: id,
      sharedMsgId: null,
      senderMemberId: member,
      senderDisplayName: member,
      sentAt,
      type: 'text',
      textBody: `msg ${id}`,
      linksText: null,
      rawJson: { id },
    });
  }

  async function isPublished(id: number): Promise<boolean> {
    const r = await pg.query<{ published: boolean }>(
      'SELECT published FROM message_publish_state WHERE group_msg_id = $1',
      [id],
    );
    return r.rows[0]?.published === true;
  }
  async function publishedIds(): Promise<number[]> {
    const r = await pg.query<{ group_msg_id: number }>(
      'SELECT group_msg_id FROM published_messages ORDER BY group_msg_id',
    );
    return r.rows.map((x) => Number(x.group_msg_id));
  }

  // Timeline. A0 predates opt-in; A1/A2 follow it.
  await insert(A, 10, '2026-07-16T09:00:00Z'); // before opt-in
  await insert(A, 11, '2026-07-16T10:00:00Z'); // == opt-in instant
  await insert(A, 12, '2026-07-16T11:00:00Z'); // after opt-in
  await insert(B, 20, '2026-07-16T10:30:00Z'); // B never consents

  // 1) Before any /publish: nothing is published.
  check(
    'no rows published before any consent',
    (await publishedIds()).length === 0,
    JSON.stringify(await publishedIds()),
  );

  // 2) A opts in at 10:00. Forward-only: A0(09:00) stays unpublished; A1/A2 publish.
  await recordOptIn(db, A, '2026-07-16T10:00:00Z');
  check('A0 (before opt-in) unpublished', !(await isPublished(10)));
  check('A1 (== opt-in) published', await isPublished(11));
  check('A2 (after opt-in) published', await isPublished(12));
  check('B (never opted in) unpublished', !(await isPublished(20)));
  check(
    'published set is exactly {A1, A2}',
    JSON.stringify(await publishedIds()) === JSON.stringify([11, 12]),
    JSON.stringify(await publishedIds()),
  );

  // 3) A opts out at 12:00. None of A's rows remain published.
  const revoked = await recordOptOut(db, A, '2026-07-16T12:00:00Z');
  check('opt-out revoked an active consent', revoked);
  check(
    'no rows published after /unpublish',
    (await publishedIds()).length === 0,
    JSON.stringify(await publishedIds()),
  );

  // 4) A re-opts-in at 13:00. Forward-only from the NEW opt-in: only messages
  //    sent >= 13:00 publish. A message at 14:00 publishes; older ones do not.
  await recordOptIn(db, A, '2026-07-16T13:00:00Z');
  await insert(A, 13, '2026-07-16T14:00:00Z');
  check(
    'older A messages stay unpublished after re-opt-in',
    !(await isPublished(11)) && !(await isPublished(12)),
  );
  check('new A message after re-opt-in is published', await isPublished(13));
  check(
    'published set is exactly {A3}',
    JSON.stringify(await publishedIds()) === JSON.stringify([13]),
    JSON.stringify(await publishedIds()),
  );

  // 5) Deleting the published message in-group flips it out of the published set.
  const n = await markDeleted(db, GROUP_ID, [13]);
  check('markDeleted flipped 1 row', n === 1, `got ${n}`);
  check('deleted message is no longer published', !(await isPublished(13)));
  check(
    'published set empty after deletion',
    (await publishedIds()).length === 0,
    JSON.stringify(await publishedIds()),
  );

  // 6) published_messages exposes full rows (sanity: re-add a fresh published msg).
  await insert(A, 14, '2026-07-16T15:00:00Z');
  const full = await pg.query<{ text_body: string; sender_member_id: string }>(
    'SELECT text_body, sender_member_id FROM published_messages WHERE group_msg_id = 14',
  );
  check(
    'published_messages returns full message columns',
    full.rows[0]?.text_body === 'msg 14' && full.rows[0]?.sender_member_id === A,
    JSON.stringify(full.rows[0]),
  );

  // 6b) Moderation gate (Stage 5): takedown (moderation_state='rejected')
  //     removes a consented, non-deleted message from the published set.
  await pg.query(`UPDATE messages SET moderation_state = 'rejected' WHERE group_msg_id = 14`);
  check('moderation takedown excludes from published set', !(await isPublished(14)));
  await pg.query(`UPDATE messages SET moderation_state = 'none' WHERE group_msg_id = 14`);
  check('moderation restore re-includes in published set', await isPublished(14));

  // 7) Command parser.
  check(
    'parseConsentCommand recognizes /publish, /unpublish (trim+case), rejects others',
    parseConsentCommand('/publish') === 'publish' &&
      parseConsentCommand('  /UNPUBLISH ') === 'unpublish' &&
      parseConsentCommand('/publisher') === null &&
      parseConsentCommand('hello') === null,
  );

  /* ── CCB-S3-010 Addendum A — undo may only reduce exposure ──────────── */

  {
    const { journalConsentAction, undoLastConsentAction, undoReducesExposure } = await import(
      '../src/db/consent-actions.js'
    );
    const M = 'member-undo';

    // THE PRINCIPLE, stated as a rule rather than as a case.
    check('undo of an opt_in reduces exposure', undoReducesExposure('opt_in'));
    check('undo of an opt_out would INCREASE it, and is refused', !undoReducesExposure('opt_out'));

    // Opt in, then undo it: allowed, and it takes content OUT of public view.
    await journalConsentAction(db, {
      memberId: M,
      action: 'opt_in',
      source: 'natural',
      at: '2026-01-01T10:00:00Z',
      prior: { existed: false, optedInAt: null, revokedAt: null },
    });
    await recordOptIn(db, M, '2026-01-01T10:00:00Z');
    const undoneIn = await undoLastConsentAction(db, M, '2026-01-01T10:01:00Z', null);
    check('undoing an opt-in still works', undoneIn !== null);
    const { rows: after } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consent WHERE member_id = $1 AND revoked_at IS NULL',
      [M],
    );
    check('and leaves the member NOT publishing', after[0]?.n === 0);

    // Opt in, revoke, then try to undo the revocation: refused.
    await recordOptIn(db, M, '2026-01-01T11:00:00Z');
    await journalConsentAction(db, {
      memberId: M,
      action: 'opt_out',
      source: 'natural',
      at: '2026-01-01T12:00:00Z',
      prior: { existed: true, optedInAt: '2026-01-01T11:00:00Z', revokedAt: null },
    });
    await recordOptOut(db, M, '2026-01-01T12:00:00Z');

    const undoneOut = await undoLastConsentAction(db, M, '2026-01-01T12:00:30Z', null);
    check('undoing a REVOCATION is refused', undoneOut === null);
    const { rows: still } = await db.query<{ revoked: string | null }>(
      'SELECT revoked_at::text AS revoked FROM consent WHERE member_id = $1',
      [M],
    );
    check(
      'and revoked_at is NOT cleared — nothing returns to public view',
      still[0]?.revoked !== null && still[0]?.revoked !== undefined,
      String(still[0]?.revoked),
    );
    const { rows: pubAfter } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM published_messages WHERE sender_member_id = $1',
      [M],
    );
    check('no message of theirs is published after the refused undo', pubAfter[0]?.n === 0);
  }

  await pg.close();

  console.log('');
  if (failures === 0) {
    console.log('ALL CHECKS PASSED ✓');
  } else {
  console.log(`${failures} CHECK(S) FAILED ✗`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('verify-consent crashed:', err);
  process.exit(1);
});
