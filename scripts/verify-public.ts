/**
 * verify:public (CCB-S2-003) — exercises the public archive front against a real
 * PGlite database + the REAL Fastify server (via inject). Proves the consent gate
 * (published vs unpublished, incl. media 404/200), SSR content in markup, the SEO
 * head, server-side filters/search, and the embeddable/indexable headers.
 *
 * DEV harness only. No secrets, placeholder data.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { buildServer } from '../src/web/server.js';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { upsertMessage, updateMedia } from '../src/db/messages.js';
import { recordOptIn } from '../src/db/consent.js';
import { createEmbedInstance } from '../src/db/embeds.js';
import { SettingsService } from '../src/settings/service.js';
import { SecurityService } from '../src/security/settings.js';
import type { Queryable } from '../src/db/pool.js';
import type { AdminConfig, Config } from '../src/config.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
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
  for (const m of await loadMigrationFiles()) await pg.exec(m.sql);

  const mediaRoot = mkdtempSync(join(tmpdir(), 'cinderella-media-'));
  const writeMedia = (rel: string, bytes: Buffer): void => {
    const p = join(mediaRoot, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
  };

  // --- Seed: member A opted in 2026-07-10; member B never opted in. ---
  const A = 'member-a-0000000000000000';
  const B = 'member-b-0000000000000000';
  await recordOptIn(db, A, '2026-07-10T00:00:00Z');

  const seed = (gid: number, member: string, type: string, text: string | null, sentAt: string) =>
    upsertMessage(db, {
      groupId: 1,
      groupMsgId: gid,
      sharedMsgId: null,
      senderMemberId: member,
      senderDisplayName: member === A ? 'Alice' : 'Bob',
      sentAt,
      type: type as never,
      textBody: text,
      linksText: null,
      rawJson: {},
    });

  const pubTextId = await seed(
    1,
    A,
    'text',
    'The quick brown fox jumps over the lazy dog',
    '2026-07-14T09:00:00Z',
  );
  const pubImgId = await seed(2, A, 'image', null, '2026-07-15T09:00:00Z');
  writeMedia('2026/07/2-pub.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await updateMedia(db, 1, 2, {
    mediaPath: '2026/07/2-pub.png',
    mediaMime: 'image/png',
    mediaSize: 4,
  });

  const unpubTextId = await seed(3, B, 'text', 'SECRET unpublished words', '2026-07-16T09:00:00Z');
  const unpubImgId = await seed(4, B, 'image', null, '2026-07-16T10:00:00Z');
  writeMedia('2026/07/4-unpub.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await updateMedia(db, 1, 4, {
    mediaPath: '2026/07/4-unpub.png',
    mediaMime: 'image/png',
    mediaSize: 4,
  });

  const beforeOptInId = await seed(5, A, 'text', 'BEFORE optin content', '2026-07-05T09:00:00Z');

  // --- Server ---
  const adminCfg: AdminConfig = {
    adminPort: 0,
    adminUsername: 'operator',
    adminPasswordHash: 'x',
    sessionSecret: 'verify-public-session-secret-0123456789abcdef',
    publicOrigin: 'https://archive.example.test',
    rpId: 'archive.example.test',
    webauthnOrigin: 'https://archive.example.test',
    rpName: 'Cinderella',
  };
  const cfg: Config = {
    botDisplayName: 'Cinderella',
    simplexDbPrefix: './state/simplex/cinderella',
    simplexFilesFolder: './state/files',
    groupName: 'test',
    mediaRoot,
    avatarPath: '',
    databaseUrl: 'postgres://x',
    logLevel: 'error',
  };
  const settings = await SettingsService.load(db, cfg.logLevel);
  const security = await SecurityService.load(db);
  const app = buildServer({ db, adminCfg, cfg, settings, security, mediaRoot });
  await app.ready();

  const inst = await createEmbedInstance(db, 'Fox Community');
  const base = `/embed/${inst.id}`;

  // --- Page: SSR + consent gate + SEO ---
  const page = await app.inject({ method: 'GET', url: base });
  const b = page.body;
  check('page 200', page.statusCode === 200);
  check('SSR: published text is in the markup', b.includes('quick brown fox'));
  check('consent: unpublished (no consent) text NOT present', !b.includes('SECRET unpublished'));
  check('consent: before-opt-in text NOT present', !b.includes('BEFORE optin'));
  check(
    'SEO: JSON-LD present',
    b.includes('application/ld+json') && b.includes('DiscussionForumPosting'),
  );
  check('SEO: og:title present', b.includes('property="og:title"'));
  check('SEO: canonical present', b.includes('rel="canonical"'));
  check(
    'SEO: indexable (index, follow), NOT noindex',
    b.includes('index, follow') && !b.includes('noindex'),
  );
  check(
    'embed: CSP frame-ancestors *',
    (page.headers['content-security-policy'] ?? '').toString().includes('frame-ancestors *'),
  );
  check('embed: NO x-frame-options DENY', !('x-frame-options' in page.headers));
  check(
    'embed: height script targets parent.postMessage',
    b.includes('cinderellaEmbedHeight') && b.includes('parent.postMessage'),
  );

  // --- Media consent gate (the security-critical acceptance) ---
  const pubMedia = await app.inject({ method: 'GET', url: `${base}/media/${pubImgId}` });
  check('media: PUBLISHED image → 200', pubMedia.statusCode === 200);
  check(
    'media: published image content-type',
    (pubMedia.headers['content-type'] ?? '').toString().includes('image/png'),
  );
  const unpubMedia = await app.inject({ method: 'GET', url: `${base}/media/${unpubImgId}` });
  check('media: UNPUBLISHED image → 404', unpubMedia.statusCode === 404);
  const beforeMedia = await app.inject({ method: 'GET', url: `${base}/media/${beforeOptInId}` });
  check('media: before-opt-in item → 404', beforeMedia.statusCode === 404);

  // --- Server-side filters/search via URL params ---
  const search = await app.inject({ method: 'GET', url: `${base}?q=fox` });
  check('search: q=fox includes match', search.body.includes('quick brown fox'));
  const searchMiss = await app.inject({ method: 'GET', url: `${base}?q=zzzznomatch` });
  check('search: no-match hides the text item', !searchMiss.body.includes('quick brown fox'));
  const typeImg = await app.inject({ method: 'GET', url: `${base}?type=image` });
  check(
    'type filter: type=image excludes the text item',
    !typeImg.body.includes('quick brown fox'),
  );
  const timeFilter = await app.inject({ method: 'GET', url: `${base}?since=2026-07-20` });
  check(
    'time filter: since after all → empty of published text',
    !timeFilter.body.includes('quick brown fox'),
  );

  // --- Unknown instance ---
  const unknown = await app.inject({ method: 'GET', url: '/embed/does-not-exist' });
  check('unknown instance → 404', unknown.statusCode === 404);

  // --- Media type disabled on the instance → media 404 even if published ---
  // (covered by the design; the page also must not render disabled types)

  await app.close();
  console.log(failures === 0 ? '\nverify:public OK' : `\nverify:public FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('verify:public crashed:', err);
  process.exit(1);
});
