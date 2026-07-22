/**
 * Remediation for media captured before stripping existed (CCB-S3-011 §1.4).
 *
 * Generates a stripped derivative for every stored file that has none, and
 * reports what was found IN AGGREGATE. It prints counts, never a coordinate and
 * never a filename — an audit that copies the leak into a terminal and a shell
 * history has not fixed anything.
 *
 *   MEDIA_ROOT=… DATABASE_URL=… npx tsx scripts/remediate-media.ts [--dry-run]
 */

import { Pool } from 'pg';
import { stripAndRecord } from '../src/media/pipeline.js';
import { readExifSummary } from '../src/media/exif.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Queryable } from '../src/db/pool.js';

interface Row {
  id: string;
  media_path: string;
  media_mime: string | null;
  type: string;
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry-run');
  const mediaRoot = process.env['MEDIA_ROOT'];
  if (!mediaRoot) throw new Error('MEDIA_ROOT is required.');
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  const db: Queryable = { query: (t, v) => pool.query(t, v as never) as never };

  const { rows } = await pool.query<Row>(
    `SELECT id::text, media_path, media_mime, type::text AS type
       FROM messages
      WHERE media_path IS NOT NULL AND media_derived_path IS NULL
      ORDER BY id`,
  );

  let stripped = 0;
  let hadMetadata = 0;
  let hadGps = 0;
  let unstrippable = 0;
  let failed = 0;

  for (const r of rows) {
    if (dry) {
      try {
        const buf = await readFile(join(mediaRoot, r.media_path));
        const f = readExifSummary(buf);
        if (f.hasExif || f.hasXmp || f.hasIptc || f.hasContainerTags) hadMetadata++;
        if (f.hasGps) hadGps++;
      } catch {
        failed++;
      }
      continue;
    }
    try {
      const out = await stripAndRecord(db, mediaRoot, Number(r.id), r.media_path, r.media_mime);
      if (out.stripped) stripped++;
      if (out.hadMetadata) hadMetadata++;
      if (out.hadGps) hadGps++;
      if (out.skipped) unstrippable++;
      if (!out.stripped && !out.skipped) failed++;
    } catch {
      failed++;
    }
  }

  console.log(`\nMEDIA REMEDIATION${dry ? ' (dry run)' : ''}`);
  console.log(`  files needing a derivative   ${rows.length}`);
  console.log(`  stripped derivatives written ${stripped}`);
  console.log(`  carried metadata of any kind ${hadMetadata}`);
  console.log(`  carried GPS coordinates      ${hadGps}`);
  console.log(`  format has no stripper here  ${unstrippable}`);
  console.log(`  failed                       ${failed}`);
  if (failed > 0) {
    console.log('\n  Failed files are NOT published: the serving gate refuses a strippable');
    console.log('  format with no derivative, so a failure withholds rather than leaks.');
  }
  await pool.end();
}

void main();
