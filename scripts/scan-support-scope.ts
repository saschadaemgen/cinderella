/**
 * CCB-S3-019 §4 — find (and, with --remove, remediate) any PRIVATE support-scope
 * message that was captured before the scope gate existed.
 *
 * A member's "Chat with admins" thread arrives on the same event as ordinary
 * group messages, distinguished only by `chatInfo.groupChatScope`. Before the gate
 * (src/capture/message.ts, isPublicGroupChat) such an item could be persisted and,
 * if the member had opted in, published. This script inspects the stored
 * `raw_json` for that discriminator and reports the EXTENT — counts, message ids,
 * and affected member ids — and NEVER the private content itself (no text bodies,
 * no display names). Copying a private conversation into a terminal and a shell
 * history would not be remediation.
 *
 *   DATABASE_URL=… npx tsx scripts/scan-support-scope.ts            # read-only scan
 *   DATABASE_URL=… MEDIA_ROOT=… npx tsx scripts/scan-support-scope.ts --remove
 *
 * --remove hard-deletes the offending rows (FKs cascade: links, mentions, reports,
 * replies) inside one transaction, and unlinks any stored media bytes if MEDIA_ROOT
 * is set. The row leaving `messages` removes it from `published_messages` at once.
 */

import { Pool } from 'pg';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

interface Row {
  id: string;
  type: string;
  sender_member_id: string;
  published: boolean;
  deleted: boolean;
  media_path: string | null;
  media_derived_path: string | null;
}

const SCOPED_WHERE = `raw_json -> 'chatInfo' -> 'groupChatScope' IS NOT NULL`;

async function main(): Promise<void> {
  const remove = process.argv.includes('--remove');
  const mediaRoot = process.env['MEDIA_ROOT'];
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

  const { rows } = await pool.query<Row>(
    `SELECT m.id::text, m.type::text AS type, m.sender_member_id,
            (p.id IS NOT NULL) AS published,
            (m.deleted OR m.group_deleted) AS deleted,
            m.media_path, m.media_derived_path
       FROM messages m
       LEFT JOIN published_messages p ON p.id = m.id
      WHERE ${SCOPED_WHERE}
      ORDER BY m.id`,
  );

  const publishedNow = rows.filter((r) => r.published).length;
  const withMedia = rows.filter((r) => r.media_path).length;
  const members = new Set(rows.map((r) => r.sender_member_id));

  console.log(`\nSUPPORT-SCOPE SCAN${remove ? ' (REMOVE)' : ' (read-only)'}`);
  console.log(`  captured support-scope rows      ${rows.length}`);
  console.log(`  …currently PUBLISHED (leaked)     ${publishedNow}`);
  console.log(`  …carrying media bytes            ${withMedia}`);
  console.log(`  distinct affected members        ${members.size}`);
  if (rows.length > 0) {
    console.log(`  message ids                      ${rows.map((r) => r.id).join(', ')}`);
    console.log(`  member ids                       ${[...members].join(', ')}`);
  }

  if (rows.length === 0) {
    console.log('\n  Clean: no private support-scope message was ever captured.');
    await pool.end();
    return;
  }

  if (!remove) {
    console.log('\n  Read-only. Re-run with --remove (and MEDIA_ROOT set) to delete these rows.');
    await pool.end();
    return;
  }

  const ids = rows.map((r) => Number(r.id));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FKs (links, message_mentions, content_reports, reply_to_id) are ON DELETE
    // CASCADE, so one delete removes the row and everything hanging off it.
    const del = await client.query(`DELETE FROM messages WHERE id = ANY($1::bigint[])`, [ids]);
    await client.query('COMMIT');
    console.log(`\n  Deleted ${del.rowCount ?? 0} row(s) from messages (cascaded dependents).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Best-effort: unlink the orphaned media bytes. The public exposure is already
  // closed by the row deletion (serving goes through published_messages); this is
  // disk hygiene, so a missing file is not an error.
  if (mediaRoot) {
    let unlinked = 0;
    for (const r of rows) {
      for (const p of [r.media_path, r.media_derived_path]) {
        if (!p) continue;
        try {
          await unlink(join(mediaRoot, p));
          unlinked++;
        } catch {
          /* already gone — fine */
        }
      }
    }
    console.log(`  Unlinked ${unlinked} media file(s) from MEDIA_ROOT.`);
  } else if (withMedia > 0) {
    console.log(`  ${withMedia} row(s) had media bytes; set MEDIA_ROOT to unlink them too.`);
  }

  await pool.end();
}

void main();
