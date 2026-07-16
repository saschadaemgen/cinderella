/**
 * Stage 2 verification harness.
 *
 * Runs the REAL migration SQL and the REAL write-path (upsertMessage /
 * replaceLinks / updateMedia) plus link extraction against an in-process
 * Postgres engine (PGlite — Postgres compiled to WASM), then asserts the
 * Stage 2 acceptance: correct rows in `messages` and `links`, media path
 * recorded, and a full-text query returns the text message.
 *
 * This needs no external Postgres/daemon. Production/CI uses a real PostgreSQL
 * server via DATABASE_URL and the same SQL.
 *
 *   npx tsx scripts/verify-db.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { replaceLinks, updateMedia, upsertMessage } from '../src/db/messages.js';
import { extractLinks, linksToSearchText } from '../src/capture/links.js';
import type { Queryable } from '../src/db/pool.js';
import type { CapturedMessage } from '../src/capture/message.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function mkMsg(over: Partial<CapturedMessage>): CapturedMessage {
  return {
    groupId: 1,
    groupName: 'cinderella-test',
    itemId: 0,
    sharedMsgId: undefined,
    senderMemberId: 'member-AAA',
    senderDisplayName: 'Alice',
    sentAt: '2026-07-16T10:00:00.000Z',
    type: 'text',
    text: '',
    linkPreview: undefined,
    file: undefined,
    raw: { placeholder: true } as unknown as CapturedMessage['raw'],
    ...over,
  };
}

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

  console.log('Applying migrations to PGlite…');
  const migrations = await loadMigrationFiles();
  for (const m of migrations) await pg.exec(m.sql);
  check('migrations applied', migrations.length > 0, `${migrations.length} file(s)`);

  // --- Insert a mix: text, an image (with media), and a link message. ---

  // Text message with a distinctive word for the FTS check.
  const textMsg = mkMsg({
    itemId: 101,
    type: 'text',
    text: 'The pumpkin carriage departs at midnight sharp',
  });
  const textId = await upsertMessage(db, {
    groupId: textMsg.groupId,
    groupMsgId: textMsg.itemId,
    sharedMsgId: null,
    senderMemberId: textMsg.senderMemberId,
    senderDisplayName: textMsg.senderDisplayName,
    sentAt: textMsg.sentAt,
    type: textMsg.type,
    textBody: textMsg.text,
    linksText: null,
    rawJson: textMsg.raw,
  });

  // Image message with an attached file received into the media store.
  const imageMsg = mkMsg({
    itemId: 102,
    senderMemberId: 'member-BBB',
    senderDisplayName: 'Bob',
    type: 'image',
    text: '',
    sentAt: '2026-07-16T11:30:00.000Z',
  });
  await upsertMessage(db, {
    groupId: imageMsg.groupId,
    groupMsgId: imageMsg.itemId,
    sharedMsgId: null,
    senderMemberId: imageMsg.senderMemberId,
    senderDisplayName: imageMsg.senderDisplayName,
    sentAt: imageMsg.sentAt,
    type: imageMsg.type,
    textBody: null,
    linksText: null,
    rawJson: imageMsg.raw,
  });
  await updateMedia(db, imageMsg.groupId, imageMsg.itemId, {
    mediaPath: '2026/07/102-glass_slipper.jpg',
    mediaMime: 'image/jpeg',
    mediaSize: 20480,
  });

  // Link message: a URL whose host is NOT present in text_body, so the FTS
  // match can only come from links_text.
  const linkMsg = mkMsg({
    itemId: 103,
    type: 'link',
    text: 'look here',
    sentAt: '2026-07-16T12:00:00.000Z',
    linkPreview: {
      url: 'https://gazette.example/royal-ball',
      title: 'Royal Ball Gazette',
      description: 'Coverage of the royal ball',
    },
  });
  const linkExtracted = extractLinks(linkMsg);
  const linkId = await upsertMessage(db, {
    groupId: linkMsg.groupId,
    groupMsgId: linkMsg.itemId,
    sharedMsgId: null,
    senderMemberId: linkMsg.senderMemberId,
    senderDisplayName: linkMsg.senderDisplayName,
    sentAt: linkMsg.sentAt,
    type: linkMsg.type,
    textBody: linkMsg.text,
    linksText: linksToSearchText(linkExtracted),
    rawJson: linkMsg.raw,
  });
  await replaceLinks(
    db,
    linkId,
    linkExtracted.map((l) => ({
      url: l.url,
      title: l.title ?? null,
      description: l.description ?? null,
    })),
  );

  // --- Assertions ---

  const total = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM messages');
  check('3 messages inserted', total.rows[0]?.n === 3, `got ${total.rows[0]?.n}`);

  const types = await pg.query<{ type: string }>('SELECT type FROM messages ORDER BY group_msg_id');
  check(
    'types classified text/image/link',
    JSON.stringify(types.rows.map((r) => r.type)) === JSON.stringify(['text', 'image', 'link']),
    types.rows.map((r) => r.type).join(','),
  );

  const media = await pg.query<{ media_path: string; media_mime: string; media_size: number }>(
    'SELECT media_path, media_mime, media_size FROM messages WHERE group_msg_id = 102',
  );
  check(
    'media path/mime/size recorded for image',
    media.rows[0]?.media_path === '2026/07/102-glass_slipper.jpg' &&
      media.rows[0]?.media_mime === 'image/jpeg' &&
      Number(media.rows[0]?.media_size) === 20480,
    JSON.stringify(media.rows[0]),
  );

  const links = await pg.query<{ url: string; title: string }>(
    'SELECT url, title FROM links WHERE message_id = $1',
    [linkId],
  );
  check(
    'link row extracted',
    links.rows.length === 1 && links.rows[0]?.url === 'https://gazette.example/royal-ball',
    JSON.stringify(links.rows),
  );

  // FTS over text_body: find the text message by a word from its body.
  const ftsText = await pg.query<{ id: string; text_body: string }>(
    `SELECT id, text_body FROM messages WHERE search @@ plainto_tsquery('simple', $1)`,
    ['midnight'],
  );
  check(
    'FTS returns the text message for "midnight"',
    ftsText.rows.length === 1 && Number(ftsText.rows[0]?.id) === textId,
    JSON.stringify(ftsText.rows.map((r) => r.text_body)),
  );

  // FTS over links_text: the link message is found by a word only in the link
  // title (not in its text_body) — proves links_text feeds the tsvector.
  const ftsLink = await pg.query<{ id: string }>(
    `SELECT id FROM messages WHERE search @@ plainto_tsquery('simple', $1)`,
    ['gazette'],
  );
  check(
    'FTS returns the link message for "gazette" (from links_text)',
    ftsLink.rows.length === 1 && Number(ftsLink.rows[0]?.id) === linkId,
    JSON.stringify(ftsLink.rows),
  );

  // Type + time filter (uses the (type, sent_at) index).
  const byType = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE type = 'image' AND sent_at >= '2026-07-16T00:00:00Z'`,
  );
  check('type+time filter returns the image', byType.rows[0]?.n === 1, `got ${byType.rows[0]?.n}`);

  // Defaults.
  const defaults = await pg.query<{ deleted: boolean; moderation_state: string }>(
    'SELECT deleted, moderation_state FROM messages WHERE group_msg_id = 101',
  );
  check(
    'defaults: deleted=false, moderation_state=none',
    defaults.rows[0]?.deleted === false && defaults.rows[0]?.moderation_state === 'none',
    JSON.stringify(defaults.rows[0]),
  );

  // Idempotency: re-upsert the same (group_id, group_msg_id) — still 3 rows.
  await upsertMessage(db, {
    groupId: textMsg.groupId,
    groupMsgId: textMsg.itemId,
    sharedMsgId: 'redelivered',
    senderMemberId: textMsg.senderMemberId,
    senderDisplayName: textMsg.senderDisplayName,
    sentAt: textMsg.sentAt,
    type: 'text',
    textBody: textMsg.text,
    linksText: null,
    rawJson: textMsg.raw,
  });
  const afterReupsert = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM messages');
  check(
    're-delivery is idempotent (still 3 rows)',
    afterReupsert.rows[0]?.n === 3,
    `got ${afterReupsert.rows[0]?.n}`,
  );

  // Link extraction from free text (no preview).
  const textLinks = extractLinks(
    mkMsg({ text: 'see https://example.org/path, and (http://a.test) too.' }),
  );
  check(
    'extractLinks pulls http(s) URLs from text, trims punctuation',
    textLinks.length === 2 &&
      textLinks.some((l) => l.url === 'https://example.org/path') &&
      textLinks.some((l) => l.url === 'http://a.test'),
    JSON.stringify(textLinks.map((l) => l.url)),
  );

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
  console.error('verify-db crashed:', err);
  process.exit(1);
});
