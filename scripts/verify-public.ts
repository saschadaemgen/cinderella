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
import { embedSnippet } from '../src/web/views/embeds.js';
import { listPublishedSpanState, decodeCursor, ARCHIVE_TYPES } from '../src/db/public-archive.js';
import { isPublicFront } from '../src/web/front/embed.js';
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

  // Video: one published (member A), one unpublished (member B) — CCB-S2-008.
  const pubVideoId = await seed(10, A, 'video', null, '2026-07-15T12:00:00Z');
  writeMedia('2026/07/10-pub.mp4', Buffer.from([0x00, 0x00, 0x00, 0x18]));
  await updateMedia(db, 1, 10, {
    mediaPath: '2026/07/10-pub.mp4',
    mediaMime: 'video/mp4',
    mediaSize: 4,
  });
  const unpubVideoId = await seed(11, B, 'video', null, '2026-07-16T12:00:00Z');
  writeMedia('2026/07/11-unpub.mp4', Buffer.from([0x00, 0x00, 0x00, 0x18]));
  await updateMedia(db, 1, 11, {
    mediaPath: '2026/07/11-unpub.mp4',
    mediaMime: 'video/mp4',
    mediaSize: 4,
  });

  // Bulk published items (CCB-S2-007) — 35 messages OLDER than the named ones above
  // (so page-1 assertions still hold) but after opt-in, giving a real 2-page dataset
  // for cursor paging + rel=next/prev. Timestamps 2026-07-11T00:00…17:00, distinct.
  const BULK = 35;
  for (let i = 0; i < BULK; i++) {
    const hh = String(Math.floor(i / 2)).padStart(2, '0');
    const mm = i % 2 === 0 ? '00' : '30';
    await seed(100 + i, A, 'text', `bulk message ${i}`, `2026-07-11T${hh}:${mm}:00Z`);
  }

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

  // ===== CCB-S2-008: inline video player + download toggle =====
  const vpage = await app.inject({ method: 'GET', url: base });
  const vb = vpage.body;
  check(
    'video: renders inline <video> with controls (not a link)',
    vb.includes(`id="msg-${pubVideoId}"`) &&
      /<video[^>]*\bcontrols\b/.test(vb) &&
      !vb.includes('Open video'),
  );
  check(
    'video: metadata preload + playsinline, no autoplay',
    /<video[^>]*preload="metadata"/.test(vb) &&
      /<video[^>]*\bplaysinline\b/.test(vb) &&
      !vb.includes('autoplay'),
  );
  check(
    'video: rendered <video> carries the house-styled media class',
    /<video[^>]*\bclass="[^"]*\bmedia\b[^"]*"/.test(vb) && vb.includes('.item video.media{'),
  );
  check(
    'video: CSP allows inline playback (media-src self)',
    (vpage.headers['content-security-policy'] ?? '').toString().includes("media-src 'self'"),
  );
  check(
    'embed snippet: iframe grants fullscreen (allow + legacy allowfullscreen)',
    /allow="fullscreen"/.test(embedSnippet('https://x.test', inst.id)) &&
      /\ballowfullscreen\b/.test(embedSnippet('https://x.test', inst.id)),
  );
  check(
    'video: height re-posts on loadedmetadata + fullscreenchange',
    vb.includes('loadedmetadata') && vb.includes('fullscreenchange'),
  );
  check(
    'video download: button shown by default (default ON)',
    vb.includes('class="dl-btn"') && /download="cinderella-video-/.test(vb),
  );
  check('video download: no nodownload while enabled', !/controlslist="nodownload"/i.test(vb));

  // Consent: unpublished video never served/rendered.
  check('video consent: unpublished video NOT in markup', !vb.includes(`id="msg-${unpubVideoId}"`));
  const pubVid = await app.inject({ method: 'GET', url: `${base}/media/${pubVideoId}` });
  check('video consent: published video media → 200', pubVid.statusCode === 200);
  const unpubVid = await app.inject({ method: 'GET', url: `${base}/media/${unpubVideoId}` });
  check('video consent: unpublished video media → 404', unpubVid.statusCode === 404);

  // Byte-range: WebKit refuses to play inline <video> without 206; seeking needs it.
  check(
    'video range: full 200 advertises accept-ranges',
    (pubVid.headers['accept-ranges'] ?? '') === 'bytes',
  );
  const rangeReq = await app.inject({
    method: 'GET',
    url: `${base}/media/${pubVideoId}`,
    headers: { range: 'bytes=0-1' },
  });
  check('video range: Range request → 206 Partial Content', rangeReq.statusCode === 206);
  check(
    'video range: 206 carries content-range + 2-byte content-length',
    /^bytes 0-1\/\d+$/.test((rangeReq.headers['content-range'] ?? '').toString()) &&
      (rangeReq.headers['content-length'] ?? '') === '2',
  );
  // The range branch must sit AFTER the consent gate: an unpublished id still 404s.
  const unpubRange = await app.inject({
    method: 'GET',
    url: `${base}/media/${unpubVideoId}`,
    headers: { range: 'bytes=0-1' },
  });
  check('video range consent: unpublished + Range still → 404', unpubRange.statusCode === 404);

  // Download toggle OFF → button hidden AND controlsList=nodownload on the player.
  await updateEmbedInstance(
    db,
    inst.id,
    inst.name,
    normalizeEmbedSettings({ ...D, player: { showDownload: false } }),
  );
  const voff = await app.inject({ method: 'GET', url: base });
  check('video toggle off: download button hidden', !voff.body.includes('class="dl-btn"'));
  check(
    'video toggle off: controlsList=nodownload set',
    /controlslist="nodownload"/i.test(voff.body),
  );
  await updateEmbedInstance(db, inst.id, inst.name, normalizeEmbedSettings(D));

  // ===== CCB-S2-006/007: live auto-update + infinite scroll =====
  type State = { hash: string; ids: number[]; hasNewer?: boolean };
  type PageResp = { html: string; nextCursor: string | null; hasMore: boolean };
  const getState = async (url: string): Promise<State> =>
    JSON.parse((await app.inject({ method: 'GET', url })).body) as State;
  const getPage = async (url: string): Promise<PageResp> =>
    JSON.parse((await app.inject({ method: 'GET', url })).body) as PageResp;
  const idsInOrder = (body: string): number[] =>
    [...body.matchAll(/id="msg-(\d+)"/g)].map((m) => Number(m[1]));
  const cardCursors = (body: string): { id: number; cursor: string }[] =>
    [...body.matchAll(/id="msg-(\d+)" data-cursor="([^"]*)"/g)].map((m) => ({
      id: Number(m[1]),
      cursor: m[2] as string,
    }));
  const attr = (body: string, name: string): string =>
    (body.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1] ?? '';

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
    'live: stream client wired (state + page + visibility pause), no fragment',
    lb.includes('/state') &&
      lb.includes('/page') &&
      lb.includes('visibilitychange') &&
      lb.includes('document.hidden') &&
      !lb.includes('/fragment'),
  );
  check(
    'live: SSR content + JSON-LD still in markup (progressive enhancement)',
    lb.includes('quick brown fox') && lb.includes('application/ld+json'),
  );
  check(
    'footer: powered-by Cinderella links to the GitHub repo',
    lb.includes('github.com/saschadaemgen/cinderella') && lb.includes('powered by'),
  );

  // --- Infinite-scroll seed attributes + sentinels/spacer on #stream-list (CCB-S2-007) ---
  check(
    'scroll: seed attrs (next-cursor, has-more=1, window-cap, page-size)',
    /data-next-cursor="[A-Za-z0-9_-]+"/.test(lb) &&
      lb.includes('data-has-more="1"') &&
      /data-window-cap="\d+"/.test(lb) &&
      /data-page-size="\d+"/.test(lb),
  );
  check(
    'scroll: spacer + top/bottom sentinels present',
    lb.includes('id="stream-top-spacer"') &&
      lb.includes('id="stream-top-sentinel"') &&
      lb.includes('id="stream-bottom-sentinel"'),
  );
  check(
    'scroll: SSR page 1 has 30 cards, all carry data-cursor',
    idsInOrder(lb).length === 30 && cardCursors(lb).length === 30,
  );

  // --- rel=next/prev crawlable deep pages (CCB-S2-007) ---
  check(
    'seo: page 1 head has rel=next and NOT rel=prev',
    /<link rel="next" href="[^"]+"/.test(lb) && !/<link rel="prev"/.test(lb),
  );
  const p2 = await app.inject({ method: 'GET', url: `${base}?page=2` });
  check(
    'seo: page 2 head has rel=prev and NOT rel=next (last page)',
    /<link rel="prev" href="[^"]+"/.test(p2.body) && !/<link rel="next"/.test(p2.body),
  );
  check('seo: deep page 2 renders SSR cards server-side', idsInOrder(p2.body).length === 8);
  check(
    'scroll: data-at-top=1 on page 1, =0 on a deep page (no false auto-prepend)',
    lb.includes('data-at-top="1"') && p2.body.includes('data-at-top="0"'),
  );
  const pBig = await app.inject({ method: 'GET', url: `${base}?page=99999` });
  check(
    'seo: out-of-range page emits neither rel=prev nor rel=next (no crawl trap)',
    !/<link rel="prev"/.test(pBig.body) && !/<link rel="next"/.test(pBig.body),
  );

  // --- Cursor page endpoint: stable, consent-gated, no dupes/skips ---
  const ssrFull = [...idsInOrder(lb), ...idsInOrder(p2.body)]; // 30 + 9, newest-first
  const c1 = attr(lb, 'data-next-cursor'); // boundary between page 1 and page 2
  const older = await getPage(`${base}/page?cursor=${encodeURIComponent(c1)}&dir=older`);
  const olderIds = idsInOrder(older.html);
  check(
    'page: older chunk from the page-1 cursor == SSR page 2 (no dupes/skips)',
    JSON.stringify(olderIds) === JSON.stringify(idsInOrder(p2.body)),
  );
  check('page: older chunk reports hasMore=false at the end', older.hasMore === false);
  check(
    'page: older chunk does NOT overlap page 1 (cursor is exclusive)',
    olderIds.every((id) => !idsInOrder(lb).includes(id)),
  );
  check('page: consent — no unpublished text in a page chunk', !older.html.includes('SECRET'));
  const newer = await getPage(`${base}/page?cursor=${encodeURIComponent(c1)}&dir=newer`);
  check(
    'page: newer chunk == page 1 minus the exclusive boundary card, newest-first',
    JSON.stringify(idsInOrder(newer.html)) === JSON.stringify(idsInOrder(lb).slice(0, 29)),
  );
  const noCur = await getPage(`${base}/page?dir=older`);
  check(
    'page: no-cursor older chunk is the newest slice in full order',
    JSON.stringify(idsInOrder(noCur.html)) ===
      JSON.stringify(ssrFull.slice(0, idsInOrder(noCur.html).length)),
  );
  const badCur = await app.inject({ method: 'GET', url: `${base}/page?cursor=not*valid` });
  check('page: malformed cursor → 400 (never a silent page 1)', badCur.statusCode === 400);

  // --- State endpoint: legacy (no cursor) consent gate ---
  const st = await app.inject({ method: 'GET', url: `${base}/state` });
  check(
    'state: 200 + application/json + short-TTL cache',
    st.statusCode === 200 &&
      (st.headers['content-type'] ?? '').toString().includes('application/json') &&
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
      !s0.ids.includes(unpubVideoId) &&
      !s0.ids.includes(beforeOptInId),
  );

  // --- Span state (CCB-S2-007): the loaded band [bottom, top] + hasNewer ---
  const cc = cardCursors(lb); // 30 page-1 cards, newest-first
  const topC = cc[5].cursor;
  const botC = cc[20].cursor;
  const bandIds = cc.slice(5, 21).map((x) => x.id);
  const span = await getState(
    `${base}/state?cursor=${encodeURIComponent(botC)}&top=${encodeURIComponent(topC)}`,
  );
  check(
    'span: covers exactly the loaded band [bottom, top]',
    JSON.stringify(span.ids) === JSON.stringify(bandIds),
  );
  check('span: hasNewer=true (cards newer than top exist)', span.hasNewer === true);
  // Falsifiable consent: recall a REAL band member and prove it drops out of the span.
  const bandVictim = bandIds[8];
  await db.query(`UPDATE messages SET moderation_state = 'rejected' WHERE id = $1`, [bandVictim]);
  const spanRecalled = await getState(
    `${base}/state?cursor=${encodeURIComponent(botC)}&top=${encodeURIComponent(topC)}`,
  );
  check(
    'span: consent — a recalled band member drops out (was present, now gone)',
    span.ids.includes(bandVictim) && !spanRecalled.ids.includes(bandVictim),
  );
  await db.query(`UPDATE messages SET moderation_state = 'none' WHERE id = $1`, [bandVictim]);
  // Directly stress the LIMIT (the HTTP SPAN_CAP=250 can't be hit with this seed):
  // a small cap must truncate from the OLDEST, returning the band's NEWEST ids.
  const truncated = await listPublishedSpanState(
    db,
    ARCHIVE_TYPES,
    {} as never,
    decodeCursor(botC)!,
    decodeCursor(topC)!,
    4,
  );
  check(
    'span: cap LIMIT truncates from the oldest (returns the 4 newest band ids)',
    JSON.stringify(truncated.ids) === JSON.stringify(bandIds.slice(0, 4)),
  );

  // --- Add-on-publish: a new opted-in message appears; hash changes ---
  const freshId = await seed(6, A, 'text', 'FRESHLY published banana', '2026-07-18T09:00:00Z');
  const sAdd = await getState(`${base}/state`);
  check('add: state hash changes after publish', sAdd.hash !== s0.hash);
  check('add: newly published id appears in state', sAdd.ids.includes(freshId));
  const afterAdd = await app.inject({ method: 'GET', url: base });
  check(
    'add: SSR page now renders the new card at the top',
    idsInOrder(afterAdd.body)[0] === freshId,
  );

  // --- Remove-on-recall: reject a published item; it leaves state, page AND media 404s ---
  const preRecallMedia = await app.inject({ method: 'GET', url: `${base}/media/${pubImgId}` });
  check('recall: media served before recall (200)', preRecallMedia.statusCode === 200);
  const sBefore = await getState(`${base}/state`);
  await db.query(`UPDATE messages SET moderation_state = 'rejected' WHERE id = $1`, [pubImgId]);
  const sAfter = await getState(`${base}/state`);
  check('recall: state hash changes after recall', sAfter.hash !== sBefore.hash);
  check('recall: recalled id leaves state', !sAfter.ids.includes(pubImgId));
  const postRecallMedia = await app.inject({ method: 'GET', url: `${base}/media/${pubImgId}` });
  check('recall: recalled media now 404s', postRecallMedia.statusCode === 404);
  const pageRecall = await getPage(`${base}/page?dir=older`);
  check(
    'recall: page chunk drops the recalled card',
    !idsInOrder(pageRecall.html).includes(pubImgId),
  );
  await db.query(`UPDATE messages SET moderation_state = 'none' WHERE id = $1`, [pubImgId]);

  // ===== CCB-S2-009: public content reporting =====
  const report = (
    msg: number | string,
    reason: string,
    note = '',
  ): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> =>
    app.inject({
      method: 'POST',
      url: `${base}/report`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `msg=${msg}&reason=${reason}&note=${encodeURIComponent(note)}`,
    }) as never;
  const reportRows = async (id: number): Promise<{ note: string | null }[]> =>
    (
      await db.query<{ note: string | null }>('SELECT note FROM reports WHERE message_id = $1', [
        id,
      ])
    ).rows;

  check(
    'report: per-item no-JS <details> report form present in cards',
    lb.includes('<details class="report"') &&
      lb.includes('/report"') &&
      lb.includes('name="reason"'),
  );
  const r1 = await report(pubTextId, 'illegal', 'bad content');
  check(
    'report: POST → 303 to ?reported=1 with NO session/CSRF (front exempt)',
    r1.statusCode === 303 && (r1.headers['location'] ?? '').toString().includes('reported=1'),
  );
  check('report: exactly one row stored', (await reportRows(pubTextId)).length === 1);
  const stillThere = await app.inject({ method: 'GET', url: base });
  check(
    'report: reported item is NOT hidden (visible-until-review)',
    stillThere.body.includes(`id="msg-${pubTextId}"`),
  );
  const r2 = await report(pubTextId, 'spam', 'dup');
  check(
    'report: dedup — repeat from same client+day absorbed (still one row)',
    r2.statusCode === 303 && (await reportRows(pubTextId)).length === 1,
  );
  const banner = await app.inject({ method: 'GET', url: `${base}?reported=1` });
  check(
    'report: ?reported=1 renders the confirmation banner',
    banner.body.includes('class="report-ok"'),
  );

  const rUnpub = await report(unpubTextId, 'illegal', 'x');
  check(
    'report consent: unpublished item → neutral 303, NO row (no oracle)',
    rUnpub.statusCode === 303 && (await reportRows(unpubTextId)).length === 0,
  );
  const rBad = await report(pubImgId, 'notareason', 'x');
  check('report: invalid reason → 400', rBad.statusCode === 400);
  await report(pubVideoId, 'other', 'z'.repeat(1500));
  check(
    'report: note capped at 1000 chars',
    ((await reportRows(pubVideoId))[0]?.note ?? '').length === 1000,
  );
  // The CSRF exemption is scoped to isPublicFront — pin the matcher boundary directly
  // (the r1 POST above already proved the front's report POST needs no CSRF; the admin
  // harness proves a session'd admin mutation without _csrf is 403'd — the two halves).
  check(
    'report: CSRF exemption is SCOPED to the front (isPublicFront boundary)',
    isPublicFront('/embed/x/report') === true &&
      isPublicFront('/embeds') === false &&
      isPublicFront('/messages/1/takedown') === false &&
      isPublicFront('/settings') === false,
  );
  const crossSite = await app.inject({
    method: 'POST',
    url: `${base}/report`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
    },
    payload: `msg=${pubTextId}&reason=spam`,
  });
  check(
    'report: cross-site submission is rejected (403, anti-flood)',
    crossSite.statusCode === 403,
  );
  let reportGot429 = false;
  for (let i = 0; i < 20 && !reportGot429; i++) {
    if ((await report(pubTextId, 'other', '')).statusCode === 429) reportGot429 = true;
  }
  check('report: rate-limited (429) under a burst (own strict bucket)', reportGot429);

  // --- Public-appropriate rate limits (run last: burns the buckets) ---
  let stateGot429 = false;
  for (let i = 0; i < 200 && !stateGot429; i++) {
    if ((await app.inject({ method: 'GET', url: `${base}/state` })).statusCode === 429)
      stateGot429 = true;
  }
  check('rate limit: /state returns 429 under a burst', stateGot429);
  // Cross-bucket proof: /state's bucket is now exhausted, yet /page has its OWN
  // bucket → a single /page must still succeed (would 429 under a merged regime).
  const pageAfterStateBurst = await app.inject({ method: 'GET', url: `${base}/page?dir=older` });
  check(
    'rate limit: /page still 200 after /state bucket exhausted (separate buckets)',
    pageAfterStateBurst.statusCode === 200,
  );
  let pageGot429 = false;
  for (let i = 0; i < 400 && !pageGot429; i++) {
    if ((await app.inject({ method: 'GET', url: `${base}/page?dir=older` })).statusCode === 429) {
      pageGot429 = true;
    }
  }
  check('rate limit: /page has its OWN bucket and 429s under a burst', pageGot429);

  await app.close();
  console.log(failures === 0 ? '\nverify:public OK' : `\nverify:public FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('verify:public crashed:', err);
  process.exit(1);
});
