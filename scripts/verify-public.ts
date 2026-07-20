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
import {
  createEmbedInstance,
  updateEmbedInstance,
  normalizeEmbedSettings,
  DEFAULT_EMBED_SETTINGS,
} from '../src/db/embeds.js';
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

  // ===== CCB-S2-004: full SEO & marketing suite =====
  const D = DEFAULT_EMBED_SETTINGS;
  const withSeo = (patch: Record<string, unknown>) =>
    normalizeEmbedSettings({ ...D, seo: { ...D.seo, ...patch } });

  // Full JSON-LD @graph (defaults: all types on).
  check('jsonld: WebSite + SearchAction', b.includes('"WebSite"') && b.includes('SearchAction'));
  check('jsonld: Organization', b.includes('"Organization"'));
  check(
    'jsonld: CollectionPage + BreadcrumbList',
    b.includes('CollectionPage') && b.includes('BreadcrumbList'),
  );
  check(
    'jsonld: consent — no unpublished text in structured data',
    !b.includes('SECRET unpublished'),
  );
  check('head: OG site_name + locale', b.includes('og:site_name') && b.includes('og:locale'));
  check('head: feed rel=alternate', b.includes('application/rss+xml'));

  // Toggling a type in the admin changes the output.
  await updateEmbedInstance(
    db,
    inst.id,
    inst.name,
    withSeo({ jsonld: { ...D.seo.jsonld, website: false } }),
  );
  const noWebsite = await app.inject({ method: 'GET', url: base });
  check('jsonld toggle: disabling WebSite removes it', !noWebsite.body.includes('"WebSite"'));
  await updateEmbedInstance(db, inst.id, inst.name, normalizeEmbedSettings(D));

  // Sitemap (per-instance) — published/public URLs only.
  const sm = await app.inject({ method: 'GET', url: `${base}/sitemap.xml` });
  check('sitemap: 200 + urlset', sm.statusCode === 200 && sm.body.includes('<urlset'));
  check(
    'sitemap: lists base + type-filter URL',
    sm.body.includes(`/embed/${inst.id}</loc>`) && sm.body.includes('type=image'),
  );

  // Sitemap index (origin).
  const smi = await app.inject({ method: 'GET', url: '/sitemap.xml' });
  check(
    'sitemap index: lists the instance sitemap',
    smi.statusCode === 200 && smi.body.includes(`/embed/${inst.id}/sitemap.xml`),
  );

  // robots.txt (origin) — allow front, disallow admin, reference sitemap.
  const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
  check(
    'robots.txt: allow /embed/, disallow /, sitemap ref',
    robots.body.includes('Allow: /embed/') &&
      robots.body.includes('Disallow: /') &&
      robots.body.includes('Sitemap:'),
  );

  // RSS feed — consent-gated.
  const feed = await app.inject({ method: 'GET', url: `${base}/feed.xml` });
  check(
    'feed: 200 + rss + published item',
    feed.statusCode === 200 && feed.body.includes('<rss') && feed.body.includes('quick brown fox'),
  );
  check('feed: consent — no unpublished item', !feed.body.includes('SECRET unpublished'));

  // Auto OG image — off by default → 404; enabled → 200 png.
  const ogOff = await app.inject({ method: 'GET', url: `${base}/og.png` });
  check('og image: off by default → 404', ogOff.statusCode === 404);
  await updateEmbedInstance(
    db,
    inst.id,
    inst.name,
    withSeo({ og: { ...D.seo.og, autoImage: true } }),
  );
  const ogOn = await app.inject({ method: 'GET', url: `${base}/og.png` });
  check(
    'og image: enabled → 200 image/png',
    ogOn.statusCode === 200 &&
      (ogOn.headers['content-type'] ?? '').toString().includes('image/png'),
  );
  await updateEmbedInstance(db, inst.id, inst.name, normalizeEmbedSettings(D));

  // Analytics — off by default (connect-src 'none'); configured → CSP host + script.
  const noAnalytics = await app.inject({ method: 'GET', url: base });
  check(
    'analytics: off by default (connect-src self for polling, no analytics host)',
    (noAnalytics.headers['content-security-policy'] ?? '')
      .toString()
      .includes("connect-src 'self'"),
  );
  await updateEmbedInstance(
    db,
    inst.id,
    inst.name,
    withSeo({ analytics: { scriptUrl: 'https://analytics.example.test/a.js' } }),
  );
  const withAnalytics = await app.inject({ method: 'GET', url: base });
  check(
    'analytics: configured → script tag + CSP host (not global)',
    withAnalytics.body.includes('analytics.example.test/a.js') &&
      (withAnalytics.headers['content-security-policy'] ?? '')
        .toString()
        .includes('https://analytics.example.test'),
  );
  await updateEmbedInstance(db, inst.id, inst.name, normalizeEmbedSettings(D));

  // ===== CCB-S2-005: theme (house palette, dark default + toggle) =====
  const tp = await app.inject({ method: 'GET', url: base });
  const tb = tp.body;
  check('theme: dark by default (data-theme=dark)', tb.includes('data-theme="dark"'));
  check('theme: house dark palette present', tb.includes('#45BDD1') && tb.includes('#050A12'));
  check(
    'theme: theme-color meta (dark)',
    tb.includes('name="theme-color"') && tb.includes('#050A12'),
  );
  check('theme: no-flash script reads sg-theme', tb.includes("localStorage.getItem('sg-theme')"));
  check(
    'theme: sun/moon toggle button',
    tb.includes('aria-label="Toggle theme"') &&
      tb.includes('class="sun"') &&
      tb.includes('class="moon"'),
  );
  check(
    'theme: toggle persists (localStorage.setItem sg-theme)',
    tb.includes("localStorage.setItem('sg-theme'"),
  );
  check(
    'theme: SSR + JSON-LD unchanged (progressive enhancement)',
    tb.includes('quick brown fox') && tb.includes('application/ld+json'),
  );

  // Instance mode light → data-theme=light.
  await updateEmbedInstance(
    db,
    inst.id,
    inst.name,
    normalizeEmbedSettings({ ...D, theme: { ...D.theme, mode: 'light' } }),
  );
  const lightPage = await app.inject({ method: 'GET', url: base });
  check(
    'theme: mode=light renders data-theme=light',
    lightPage.body.includes('data-theme="light"'),
  );
  await updateEmbedInstance(db, inst.id, inst.name, normalizeEmbedSettings(D));

  // Operator accent override still applies.
  await updateEmbedInstance(
    db,
    inst.id,
    inst.name,
    normalizeEmbedSettings({ ...D, theme: { ...D.theme, colorAccent: '#ec4899' } }),
  );
  const pinkPage = await app.inject({ method: 'GET', url: base });
  check('theme: operator accent override applies (#ec4899)', pinkPage.body.includes('#ec4899'));
  await updateEmbedInstance(db, inst.id, inst.name, normalizeEmbedSettings(D));

  // ===== CCB-S2-006: live auto-update (consent-gated polling) =====
  type State = { hash: string; ids: number[] };
  const getState = async (url: string): Promise<State> =>
    JSON.parse((await app.inject({ method: 'GET', url })).body) as State;

  // --- Page wiring: the progressive-enhancement client is present + CSP allows it ---
  const live = await app.inject({ method: 'GET', url: base });
  const lb = live.body;
  check(
    'live: CSP connect-src self (same-origin poll allowed)',
    (live.headers['content-security-policy'] ?? '').toString().includes("connect-src 'self'"),
  );
  check(
    'live: #stream-list present with data-poll interval',
    lb.includes('id="stream-list"') && lb.includes('data-poll="'),
  );
  check('live: non-empty initial version hash embedded', /data-hash="[0-9a-f]{8,}"/.test(lb));
  check(
    'live: poll client wired (state + fragment + visibility pause)',
    lb.includes('/state') &&
      lb.includes('/fragment') &&
      lb.includes('visibilitychange') &&
      lb.includes('document.hidden'),
  );
  check(
    'live: SSR content + JSON-LD still in markup (progressive enhancement)',
    lb.includes('quick brown fox') && lb.includes('application/ld+json'),
  );
  check(
    'footer: powered-by Cinderella links to the GitHub repo',
    lb.includes('github.com/saschadaemgen/cinderella') && lb.includes('powered by'),
  );

  // --- State endpoint: consent-gated ids + hash ---
  const st = await app.inject({ method: 'GET', url: `${base}/state` });
  check(
    'state: 200 + application/json',
    st.statusCode === 200 &&
      (st.headers['content-type'] ?? '').toString().includes('application/json'),
  );
  check(
    'state: short-TTL cache (carries ids+hash only, never content)',
    (st.headers['cache-control'] ?? '').toString().includes('max-age='),
  );
  const s0 = JSON.parse(st.body) as State;
  check('state: version hash present', typeof s0.hash === 'string' && s0.hash.length > 0);
  check(
    'state: includes the published ids',
    s0.ids.includes(pubTextId) && s0.ids.includes(pubImgId),
  );
  check(
    'state: consent — excludes unpublished / before-opt-in ids',
    !s0.ids.includes(unpubTextId) &&
      !s0.ids.includes(unpubImgId) &&
      !s0.ids.includes(beforeOptInId),
  );

  // --- Fragment endpoint: rendered region, consent-gated, partial (no <head>) ---
  const fr = await app.inject({ method: 'GET', url: `${base}/fragment` });
  check(
    'fragment: 200 + text/html',
    fr.statusCode === 200 && (fr.headers['content-type'] ?? '').toString().includes('text/html'),
  );
  check(
    'fragment: is a partial (no doctype / <head>)',
    !/<!doctype/i.test(fr.body) && !fr.body.includes('<head'),
  );
  check(
    'fragment: published text + card id present',
    fr.body.includes('quick brown fox') && fr.body.includes(`id="msg-${pubTextId}"`),
  );
  check('fragment: consent — no unpublished text', !fr.body.includes('SECRET unpublished'));

  // --- Add-on-publish: a new opted-in message appears; hash changes ---
  const freshId = await seed(6, A, 'text', 'FRESHLY published banana', '2026-07-18T09:00:00Z');
  const sAdd = await getState(`${base}/state`);
  check('add: state hash changes after publish', sAdd.hash !== s0.hash);
  check('add: newly published id appears in state', sAdd.ids.includes(freshId));
  const frAdd = await app.inject({ method: 'GET', url: `${base}/fragment` });
  check(
    'add: fragment now includes the new card',
    frAdd.body.includes('FRESHLY published banana') && frAdd.body.includes(`id="msg-${freshId}"`),
  );

  // --- Remove-on-recall: reject a published item; it leaves state AND media 404s ---
  const preRecallMedia = await app.inject({ method: 'GET', url: `${base}/media/${pubImgId}` });
  check('recall: media served before recall (200)', preRecallMedia.statusCode === 200);
  const sBefore = await getState(`${base}/state`);
  await db.query(`UPDATE messages SET moderation_state = 'rejected' WHERE id = $1`, [pubImgId]);
  const sAfter = await getState(`${base}/state`);
  check('recall: state hash changes after recall', sAfter.hash !== sBefore.hash);
  check('recall: recalled id leaves state', !sAfter.ids.includes(pubImgId));
  const postRecallMedia = await app.inject({ method: 'GET', url: `${base}/media/${pubImgId}` });
  check('recall: recalled media now 404s', postRecallMedia.statusCode === 404);
  const frRecall = await app.inject({ method: 'GET', url: `${base}/fragment` });
  check(
    'recall: fragment drops the recalled card',
    !frRecall.body.includes(`id="msg-${pubImgId}"`),
  );
  await db.query(`UPDATE messages SET moderation_state = 'none' WHERE id = $1`, [pubImgId]);

  // --- Public-appropriate rate limit on the poll endpoint (run last: burns the bucket) ---
  let got429 = false;
  for (let i = 0; i < 200; i++) {
    const r = await app.inject({ method: 'GET', url: `${base}/state` });
    if (r.statusCode === 429) {
      got429 = true;
      break;
    }
  }
  check('rate limit: /state returns 429 under a burst', got429);

  await app.close();
  console.log(failures === 0 ? '\nverify:public OK' : `\nverify:public FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('verify:public crashed:', err);
  process.exit(1);
});
