/**
 * Aggregate metadata audit of the media store (CCB-S3-011 §1.4, §1.5).
 *
 * Answers one question: what is actually inside the files we are publishing?
 * It reports COUNTS ONLY — never a coordinate, never a filename, never a serial
 * number. The point is to size the leak and prove it closed afterwards, not to
 * make a second copy of the thing that leaked.
 *
 *   npx tsx scripts/scan-media-metadata.ts            # published media only
 *   npx tsx scripts/scan-media-metadata.ts --all      # every captured file
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { readExifSummary, type ExifSummary } from '../src/media/exif.js';

interface Row {
  id: string;
  media_path: string;
  media_mime: string | null;
  type: string;
}

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  const mediaRoot = process.env['MEDIA_ROOT'];
  if (!mediaRoot) throw new Error('MEDIA_ROOT is required.');
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

  const { rows } = await pool.query<Row>(
    all
      ? `SELECT id::text, media_path, media_mime, type::text AS type
           FROM messages WHERE media_path IS NOT NULL ORDER BY id`
      : `SELECT id::text, media_path, media_mime, type::text AS type
           FROM published_messages WHERE media_path IS NOT NULL ORDER BY id`,
  );

  const summaries: { type: string; s: ExifSummary }[] = [];
  let unreadable = 0;
  for (const r of rows) {
    try {
      const buf = await readFile(join(mediaRoot, r.media_path));
      summaries.push({ type: r.type, s: readExifSummary(buf) });
    } catch {
      unreadable++;
    }
  }

  const images = summaries.filter((x) => x.type === 'image');
  const withExif = images.filter((x) => x.s.hasExif);
  const withGps = images.filter((x) => x.s.hasGps);
  const withMake = images.filter((x) => x.s.hasCamera);
  const withSerial = images.filter((x) => x.s.hasSerial);
  const withOwner = images.filter((x) => x.s.hasOwner);
  const withDate = images.filter((x) => x.s.hasTimestamp);
  const withSoftware = images.filter((x) => x.s.hasSoftware);
  const oriented = images.filter((x) => (x.s.orientation ?? 1) > 1);
  const withXmp = summaries.filter((x) => x.s.hasXmp);
  const withIptc = summaries.filter((x) => x.s.hasIptc);

  console.log(`\n${all ? 'ALL CAPTURED' : 'PUBLISHED'} MEDIA — metadata audit`);
  console.log(`  files examined            ${summaries.length}${unreadable ? ` (${unreadable} unreadable)` : ''}`);
  console.log(`  of which images           ${images.length}`);
  console.log('');
  console.log(`  images with any EXIF      ${withExif.length}  (${pct(withExif.length, images.length)})`);
  console.log(`  ├─ GPS coordinates        ${withGps.length}  (${pct(withGps.length, images.length)})`);
  console.log(`  ├─ camera make/model      ${withMake.length}`);
  console.log(`  ├─ body/lens serial       ${withSerial.length}`);
  console.log(`  ├─ owner/artist/copyright ${withOwner.length}`);
  console.log(`  ├─ capture timestamp      ${withDate.length}`);
  console.log(`  └─ software/app           ${withSoftware.length}`);
  console.log(`  images needing rotation   ${oriented.length}  (orientation tag > 1)`);
  console.log('');
  console.log(`  files with XMP packet     ${withXmp.length}`);
  console.log(`  files with IPTC block     ${withIptc.length}`);

  const byType = new Map<string, number>();
  for (const x of summaries) byType.set(x.type, (byType.get(x.type) ?? 0) + 1);
  console.log('');
  console.log(`  by type                   ${[...byType].map(([t, n]) => `${t}:${n}`).join('  ')}`);

  if (withGps.length > 0) {
    console.log('');
    console.log(`  ⚠ ${withGps.length} published image(s) carry GPS coordinates.`);
  }
  await pool.end();
}

void main();
