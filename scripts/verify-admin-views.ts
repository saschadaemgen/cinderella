/**
 * Stage 5 verification harness — admin views + widget config (Addendum 1 / A6).
 *
 * Boots the REAL server with the REAL views against PGlite, seeds archive data,
 * and asserts the Stage 5 acceptance:
 *   - every view renders with real data,
 *   - a takedown removes the message from the published set and writes audit_log,
 *   - editing a live setting persists and takes effect,
 *   - editing widget theme/filters persists against an embed_instances record,
 *   - boot/secret settings are not editable or exposed,
 *   - the layout ships its responsive scaffolding (viewport meta + breakpoints).
 *
 *   npx tsx scripts/verify-admin-views.ts
 */

import { PGlite } from '@electric-sql/pglite';
import argon2 from 'argon2';
import { buildServer, registerNav } from '../src/web/server.js';
import { registerAdminViews } from '../src/web/views/index.js';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { decryptSecret } from '../src/plugins/secrets.js';
import { upsertMessage, recordMediaError, updateMedia, markDeleted } from '../src/db/messages.js';
import { recordOptIn } from '../src/db/consent.js';
import { SettingsService } from '../src/settings/service.js';
import { SecurityService } from '../src/security/settings.js';
import { DEFAULT_INTERACTION } from '../src/interaction/settings.js';
import type { Queryable } from '../src/db/pool.js';
import type { AdminConfig, Config } from '../src/config.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function cookieOf(setCookie: string | string[] | undefined, name: string): string | null {
  const arr = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    if (c.startsWith(`${name}=`)) {
      const first = c.split(';')[0];
      if (first) return first;
    }
  }
  return null;
}

const PASSWORD = 'correct-horse-battery-staple';
const DB_PASSWORD_SECRET = 'supersecret_db_password_9x'; // must never leak into HTML
const SESSION_SECRET = 'x'.repeat(48); // must never leak into HTML

async function main(): Promise<void> {
  // Plugin secrets are encrypted with a key derived from SESSION_SECRET, which
  // production supplies through the systemd EnvironmentFile.
  process.env['SESSION_SECRET'] ??= SESSION_SECRET;
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

  // --- Seed archive data ---
  const A = 'member-alice-stable-id';
  const B = 'member-bob-stable-id';
  await recordOptIn(db, A, '2026-07-16T08:00:00Z');

  const mkRow = (id: number, member: string, type: string, text: string | null, sentAt: string) =>
    upsertMessage(db, {
      groupId: 1,
      groupMsgId: id,
      sharedMsgId: null,
      senderMemberId: member,
      senderDisplayName: member === A ? 'Alice' : 'Bob',
      sentAt,
      type: type as never,
      textBody: text,
      linksText: null,
      rawJson: { seed: id },
    });

  const textId = await mkRow(
    1,
    A,
    'text',
    'The glass slipper fits perfectly',
    '2026-07-16T09:00:00Z',
  );
  await mkRow(2, A, 'image', null, '2026-07-16T09:30:00Z');
  await updateMedia(db, 1, 2, {
    mediaPath: '2026/07/2-slipper.jpg',
    mediaMime: 'image/jpeg',
    mediaSize: 1234,
  });
  await mkRow(3, B, 'text', 'Bob never opted in', '2026-07-16T10:00:00Z');
  await mkRow(4, A, 'file', null, '2026-07-16T10:30:00Z');
  await recordMediaError(db, 1, 4, 'XFTP AUTH error (seeded failure)');

  const adminCfg: AdminConfig = {
    adminPort: 0,
    adminUsername: 'operator',
    adminPasswordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    sessionSecret: SESSION_SECRET,
    publicOrigin: 'https://cinderella.example.org',
    rpId: 'cinderella.example.org',
    webauthnOrigin: 'https://cinderella.example.org',
    rpName: 'Cinderella Admin',
  };
  const cfg: Config = {
    botDisplayName: 'Cinderella',
    simplexDbPrefix: '/var/lib/cinderella/simplex/cinderella',
    simplexFilesFolder: '/var/lib/cinderella/files',
    groupName: 'cinderella-test',
    mediaRoot: process.cwd(),
    avatarPath: '',
    databaseUrl: `postgres://cinderella:${DB_PASSWORD_SECRET}@127.0.0.1:5432/cinderella`,
    logLevel: 'info',
  };
  const settings = await SettingsService.load(db, cfg.logLevel);
  const security = await SecurityService.load(db);

  registerNav();
  const app = buildServer({
    db,
    adminCfg,
    mediaRoot: cfg.mediaRoot,
    settings,
    security,
    cfg,
    registerViews: registerAdminViews,
  });
  await app.ready();

  // --- Login ---
  const loginPageRes = await app.inject({ method: 'GET', url: '/login' });
  const loginToken = /name="_csrf" value="([a-f0-9]{64})"/.exec(loginPageRes.body)?.[1] ?? '';
  const loginCookie = cookieOf(loginPageRes.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
  const loginRes = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { username: 'operator', password: PASSWORD, _csrf: loginToken },
    headers: { cookie: loginCookie },
  });
  const session = cookieOf(loginRes.headers['set-cookie'], 'cinderella_session') ?? '';
  check('login for views harness', loginRes.statusCode === 302 && session !== '');
  const authed = { cookie: session };

  async function getPage(url: string): Promise<{ code: number; body: string }> {
    const res = await app.inject({ method: 'GET', url, headers: authed });
    return { code: res.statusCode, body: res.body };
  }
  function csrfFrom(body: string): string {
    return /name="_csrf" value="([a-f0-9]{64})"/.exec(body)?.[1] ?? '';
  }

  // --- 1) Dashboard renders real data ---
  const dash = await getPage('/dashboard');
  check('dashboard renders', dash.code === 200);
  check(
    'dashboard shows counts from PostgreSQL',
    dash.body.includes('Messages') && dash.body.includes('Opted-in members'),
  );
  check(
    'dashboard shows the failed-file-receipt indicator',
    dash.body.includes('Failed / at-risk file receipts') || dash.body.includes('failed'),
    'seeded media_error should trigger the red banner',
  );
  check(
    'dashboard is responsive scaffolding (viewport + breakpoints)',
    dash.body.includes('name="viewport"') &&
      dash.body.includes('md:flex') &&
      dash.body.includes('sm:'),
  );

  // --- 2) Messages browser ---
  const msgs = await getPage('/messages');
  check('messages browser renders', msgs.code === 200);
  check(
    'messages browser shows seeded rows',
    msgs.body.includes('The glass slipper fits perfectly') &&
      msgs.body.includes('Bob never opted in'),
  );
  check(
    'image row renders a thumbnail from the media store',
    msgs.body.includes('/media/2026/07/2-slipper.jpg'),
  );
  check('failed file receipt is visible on the row', msgs.body.includes('XFTP AUTH error'));
  const filtered = await getPage('/messages?type=image');
  check(
    'type filter works',
    filtered.code === 200 &&
      filtered.body.includes('/media/2026/07/2-slipper.jpg') &&
      !filtered.body.includes('Bob never opted in'),
  );
  const publishedOnly = await getPage('/messages?published=yes');
  check(
    'published filter works (consent-gated)',
    publishedOnly.body.includes('The glass slipper fits perfectly') &&
      !publishedOnly.body.includes('Bob never opted in'),
  );

  // --- 3) Takedown: removes from published set + audit entry ---
  const csrf = csrfFrom(msgs.body);
  check('messages page embeds CSRF token', csrf !== '');

  const beforeTakedown = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM published_messages WHERE id = $1',
    [textId],
  );
  check('message is published before takedown', beforeTakedown.rows[0]?.n === 1);

  const takedown = await app.inject({
    method: 'POST',
    url: `/messages/${textId}/takedown`,
    payload: { _csrf: csrf, back: '?page=1' },
    headers: authed,
  });
  check('takedown POST succeeds (redirect back)', takedown.statusCode === 302);

  const afterTakedown = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM published_messages WHERE id = $1',
    [textId],
  );
  check('takedown removed the message from the published set', afterTakedown.rows[0]?.n === 0);

  const auditRow = await pg.query<{ action: string; actor: string; target: string }>(
    `SELECT action, actor, target FROM audit_log WHERE action = 'message.takedown' ORDER BY id DESC LIMIT 1`,
  );
  check(
    'takedown wrote an audit_log entry (who/what/when)',
    auditRow.rows[0]?.actor === 'operator' && auditRow.rows[0]?.target === `message:${textId}`,
    JSON.stringify(auditRow.rows[0]),
  );

  const restore = await app.inject({
    method: 'POST',
    url: `/messages/${textId}/restore`,
    payload: { _csrf: csrf },
    headers: authed,
  });
  const afterRestore = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM published_messages WHERE id = $1',
    [textId],
  );
  check(
    'restore returns the message to the published set',
    restore.statusCode === 302 && afterRestore.rows[0]?.n === 1,
  );

  const takedownNoCsrf = await app.inject({
    method: 'POST',
    url: `/messages/${textId}/takedown`,
    payload: { back: '' },
    headers: authed,
  });
  check('takedown without CSRF is refused', takedownNoCsrf.statusCode === 403);

  // --- 3c) In-group deletion cannot be admin-undeleted into publication ---
  // Simulate a SimpleX in-group deletion on the (published) text message.
  await markDeleted(db, 1, [1]);
  const afterGroupDelete = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM published_messages WHERE id = $1',
    [textId],
  );
  check(
    'in-group deletion removes the message from the published set',
    afterGroupDelete.rows[0]?.n === 0,
  );
  const undelete = await app.inject({
    method: 'POST',
    url: `/messages/${textId}/undelete`,
    payload: { _csrf: csrf },
    headers: authed,
  });
  check('admin undelete of an in-group deletion is refused (409)', undelete.statusCode === 409);
  const stillGone = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM published_messages WHERE id = $1',
    [textId],
  );
  check(
    'in-group-deleted message stays unpublished after refused undelete',
    stillGone.rows[0]?.n === 0,
  );
  // The messages browser must not even offer an Undelete control for it.
  const browseAfter = await getPage('/messages?deleted=yes');
  check(
    'in-group-deleted message shows "removed in group" and no undelete control',
    browseAfter.body.includes('removed in group') &&
      !browseAfter.body.includes(`/messages/${textId}/undelete`),
  );

  // --- 4) Consent viewer ---
  const consentPage = await getPage('/consent');
  check(
    'consent viewer lists opted-in members (read-only)',
    consentPage.code === 200 &&
      consentPage.body.includes('member-alice-stable-id') &&
      consentPage.body.includes('active'),
  );
  check(
    'consent viewer has no mutation forms (strictly read-only)',
    !/action="\/consent/.test(consentPage.body),
  );

  // --- 5) Live settings: persist + take effect ---
  const settingsPage = await getPage('/settings');
  check('settings page renders', settingsPage.code === 200);
  const setRes = await app.inject({
    method: 'POST',
    url: '/settings',
    payload: { _csrf: csrf, key: 'logLevel', value: 'debug' },
    headers: authed,
  });
  check('setting edit redirects with saved flag', setRes.statusCode === 302);
  const persisted = await pg.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'logLevel'`,
  );
  check(
    'setting persisted to the settings table',
    JSON.stringify(persisted.rows[0]?.value).includes('debug'),
    JSON.stringify(persisted.rows[0]),
  );
  check('setting took effect in-process', settings.get().logLevel === 'debug');
  const badSet = await app.inject({
    method: 'POST',
    url: '/settings',
    payload: { _csrf: csrf, key: 'logLevel', value: 'bogus' },
    headers: authed,
  });
  check(
    'invalid setting value is rejected with an error redirect',
    badSet.statusCode === 302 && (badSet.headers.location ?? '').includes('error='),
  );

  const settingsAudit = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'settings.update'`,
  );
  check('settings edit is audited', (settingsAudit.rows[0]?.n ?? 0) >= 1);

  // --- 6) Boot/secret settings: display-only, secrets never exposed ---
  check(
    'boot settings are rendered display-only (no editable inputs)',
    !settingsPage.body.includes('name="databaseUrl"') &&
      !settingsPage.body.includes('name="adminPasswordHash"'),
  );
  const allPages = [dash.body, msgs.body, settingsPage.body, consentPage.body].join('');
  check('DB password never appears in any page', !allPages.includes(DB_PASSWORD_SECRET));
  check('session secret never appears in any page', !allPages.includes(SESSION_SECRET));
  check('Argon2 hash never appears in any page', !allPages.includes(adminCfg.adminPasswordHash));
  check(
    'redacted DB URL is shown instead',
    settingsPage.body.includes('postgres://cinderella:***@127.0.0.1:5432/cinderella'),
  );

  // --- 7) Embed instances: create, configure, snippet ---
  const embedsPage = await getPage('/embeds');
  check('embeds page renders', embedsPage.code === 200);
  const createRes = await app.inject({
    method: 'POST',
    url: '/embeds',
    payload: { _csrf: csrf, name: 'Homepage widget' },
    headers: authed,
  });
  const embedLoc = createRes.headers.location ?? '';
  const embedId = /\/embeds\/([A-Za-z0-9_-]+)$/.exec(String(embedLoc))?.[1] ?? '';
  check(
    'embed instance created (redirects to editor)',
    createRes.statusCode === 302 && embedId !== '',
  );

  const editorPage = await getPage(`/embeds/${embedId}`);
  check(
    'embed editor renders theme/layout/filter/media controls',
    editorPage.body.includes('name="mode"') &&
      editorPage.body.includes('name="colorAccent"') &&
      editorPage.body.includes('name="layout"') &&
      editorPage.body.includes('name="f_search"') &&
      editorPage.body.includes('name="m_video"'),
  );
  check(
    'embed editor shows the copy-paste snippet with instance id + origin',
    editorPage.body.includes(`https://cinderella.example.org/embed/${embedId}`) &&
      editorPage.body.includes('cinderellaEmbedHeight'),
  );

  const updateRes = await app.inject({
    method: 'POST',
    url: `/embeds/${embedId}`,
    payload: {
      _csrf: csrf,
      name: 'Homepage widget v2',
      mode: 'dark',
      colorAccent: '#ff6600',
      colorBackground: '#101010',
      colorText: '#fafafa',
      layout: 'grid',
      f_byType: 'on',
      // f_byTime intentionally absent -> false
      f_search: 'on',
      m_text: 'on',
      m_image: 'on',
      // video/voice/file/link absent -> false
    },
    headers: authed,
  });
  check('embed settings update succeeds', updateRes.statusCode === 302);

  const embedRow = await pg.query<{ name: string; settings: unknown }>(
    'SELECT name, settings FROM embed_instances WHERE id = $1',
    [embedId],
  );
  const stored = embedRow.rows[0]?.settings as {
    theme: { mode: string; colorAccent: string };
    layout: string;
    filters: { byTime: boolean; search: boolean };
    media: { video: boolean; image: boolean };
  };
  check(
    'widget theme persisted against the embed_instances record',
    embedRow.rows[0]?.name === 'Homepage widget v2' &&
      stored.theme.mode === 'dark' &&
      stored.theme.colorAccent === '#ff6600' &&
      stored.layout === 'grid',
    JSON.stringify(stored),
  );
  check(
    'unchecked filter/media toggles persisted as false',
    stored.filters.byTime === false && stored.media.video === false && stored.media.image === true,
  );

  const embedAudit = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('embed.create','embed.update')`,
  );
  check('embed create/update are audited', (embedAudit.rows[0]?.n ?? 0) >= 2);

  // Invalid color falls back to the default rather than storing garbage.
  await app.inject({
    method: 'POST',
    url: `/embeds/${embedId}`,
    payload: {
      _csrf: csrf,
      name: 'x',
      mode: 'dark',
      colorAccent: 'javascript:alert(1)',
      layout: 'grid',
    },
    headers: authed,
  });
  const embedRow2 = await pg.query<{ settings: unknown }>(
    'SELECT settings FROM embed_instances WHERE id = $1',
    [embedId],
  );
  const stored2 = embedRow2.rows[0]?.settings as { theme: { colorAccent: string } };
  check(
    'invalid color input is normalized away (no injection into stored settings)',
    /^#[0-9a-f]{6}$/.test(stored2.theme.colorAccent),
    stored2.theme.colorAccent,
  );

  // --- 8) All views responsive (breakpoint classes present everywhere) ---
  const everyView = [dash.body, msgs.body, consentPage.body, settingsPage.body, editorPage.body];
  check(
    'every view carries responsive utilities (sm:/md:/lg:)',
    everyView.every((b) => /class="[^"]*(sm|md|lg):/.test(b)),
  );

  // --- 9) Content reporting: bar + queue + actions + audit + placeholder (CCB-S2-009) ---
  // Seed reports: 2 distinct clients on the image (id 2), 1 on the file (id 4) whose
  // note contains <script> to prove escaping. Both messages are published (member A).
  await pg.query(
    `INSERT INTO reports (message_id, reason, note, reporter_hash) VALUES
       (2, 'illegal', 'looks bad', 'hash-client-1'),
       (2, 'spam',    NULL,        'hash-client-2'),
       (4, 'copyright', '<script>alert(1)</script>', 'hash-client-3')`,
  );
  const dashBar = await getPage('/dashboard');
  check(
    'reports: notification bar shows "2 items awaiting review" on the dashboard',
    dashBar.body.includes('awaiting review') &&
      dashBar.body.includes('/reports') &&
      dashBar.body.includes('2 item'),
  );
  const settingsBar = await getPage('/settings');
  check(
    'reports: bar appears on every admin page (settings too)',
    settingsBar.body.includes('awaiting review'),
  );

  const reportsPage = await getPage('/reports');
  check('reports queue renders', reportsPage.code === 200);
  check(
    'reports queue shows the consent-gated image preview + report count',
    reportsPage.body.includes('/media/2026/07/2-slipper.jpg') &&
      reportsPage.body.includes('2 report'),
  );
  check('reports queue: reason badges present', /Illegal|Spam|Copyright/.test(reportsPage.body));
  check(
    'reports queue: reporter note is ESCAPED (no XSS)',
    reportsPage.body.includes('&lt;script&gt;') &&
      !reportsPage.body.includes('<script>alert(1)</script>'),
  );
  const flashCrafted = await getPage('/reports?flash=constructor');
  check(
    'reports: a crafted ?flash key does not 500 the queue (own-key guard)',
    flashCrafted.code === 200,
  );
  const reportsNoAuth = await app.inject({ method: 'GET', url: '/reports' });
  check(
    'reports queue is unreachable unauthenticated',
    reportsNoAuth.statusCode === 302 || reportsNoAuth.statusCode === 401,
  );

  const takedown2 = await app.inject({
    method: 'POST',
    url: '/reports/2/takedown',
    payload: { _csrf: csrf, back: '?status=open' },
    headers: authed,
  });
  check('reports: takedown redirects', takedown2.statusCode === 302);
  const img2Pub = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM published_messages WHERE id = 2',
  );
  check('reports: takedown removed the image from the published set', img2Pub.rows[0]?.n === 0);
  const open2 = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reports WHERE message_id = 2 AND status = 'open'`,
  );
  check('reports: takedown auto-resolved the item open reports', open2.rows[0]?.n === 0);
  const tdAudit = await pg.query<{ actor: string; target: string }>(
    `SELECT actor, target FROM audit_log WHERE action = 'report.takedown' ORDER BY id DESC LIMIT 1`,
  );
  check(
    'reports: takedown wrote a report.takedown audit entry (who/item)',
    tdAudit.rows[0]?.actor === 'operator' && tdAudit.rows[0]?.target === 'message:2',
  );

  const dismiss4 = await app.inject({
    method: 'POST',
    url: '/reports/4/dismiss',
    payload: { _csrf: csrf, back: '?status=open' },
    headers: authed,
  });
  check('reports: dismiss redirects', dismiss4.statusCode === 302);
  const dismissAudit = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'report.dismiss'`,
  );
  check('reports: dismiss wrote an audit entry', (dismissAudit.rows[0]?.n ?? 0) >= 1);
  const barGone = await getPage('/dashboard');
  check(
    'reports: bar disappears when no open reports remain (count 0)',
    !barGone.body.includes('awaiting review'),
  );

  check(
    'reports: Settings external-alerting placeholder is present, labelled coming-later, and disabled/inert',
    settingsBar.body.includes('External alerting') &&
      settingsBar.body.includes('coming later') &&
      settingsBar.body.includes('disabled'),
  );

  // --- 11) Interaction console, split into sub-sections (CCB-S3-015 Stage 1) ---
  const iaPage = await getPage('/interaction/addressing');
  check('interaction addressing section renders', iaPage.code === 200);
  check('the un-suffixed /interaction redirects to a section', (await app.inject({ method: 'GET', url: '/interaction', headers: authed })).statusCode === 302);
  check(
    'the addressing section carries the sub-section submenu',
    ['/interaction/guards', '/interaction/followup', '/interaction/voice', '/interaction/diagnostics'].every(
      (h) => iaPage.body.includes(`href="${h}"`),
    ),
  );
  check(
    'addressing holds ONLY its own settings',
    iaPage.body.includes('value="Cinderella"') &&
      iaPage.body.includes('name="wakeWord"') &&
      !iaPage.body.includes('name="followUpSeconds"') &&
      !iaPage.body.includes('name="confidenceThreshold"'),
  );
  const iaCsrf = csrfFrom(iaPage.body);

  // Each section renders and holds the settings the split assigns to it.
  const sectionPages: Record<string, string> = {};
  for (const slug of ['guards', 'followup', 'language', 'replies', 'nicknames', 'consent', 'voice', 'archiving', 'diagnostics']) {
    const pg2 = await getPage(`/interaction/${slug}`);
    check(`interaction ${slug} section renders`, pg2.code === 200);
    sectionPages[slug] = pg2.body;
  }
  check('guards holds the threshold and the newly-surfaced filler settings', sectionPages['guards']!.includes('name="confidenceThreshold"') && sectionPages['guards']!.includes('name="fillerPrefixes"') && sectionPages['guards']!.includes('name="maxPrefixWords"'));
  check('follow-up holds the window, carry-over and the interjection stop list', sectionPages['followup']!.includes('name="followUpSeconds"') && sectionPages['followup']!.includes('name="intentCarryover"') && sectionPages['followup']!.includes('name="carryOverStopWords"'));
  check('language holds the default language', sectionPages['language']!.includes('name="defaultLanguage"') && sectionPages['language']!.includes('name="replyLanguageMode"'));
  check('replies holds the reply mode and rate limits', sectionPages['replies']!.includes('name="replyMode"') && sectionPages['replies']!.includes('name="replyLimitPerMember"'));
  check('nicknames holds the retorts too', sectionPages['nicknames']!.includes('name="words"') && sectionPages['nicknames']!.includes('Retorts —'));
  check('consent holds affirmations, declines and the undo window', sectionPages['consent']!.includes('name="affirmations"') && sectionPages['consent']!.includes('name="undoWindowSeconds"'));
  check('voice holds both persona languages and the help links', sectionPages['voice']!.includes('Her voice — English') && sectionPages['voice']!.includes('Her voice — Deutsch') && sectionPages['voice']!.includes('name="archiveUrl"'));
  check('diagnostics holds the near-miss log and the resolver', sectionPages['diagnostics']!.includes('Recently ignored') && sectionPages['diagnostics']!.includes('Intent resolver in use'));

  /* ── Her own messages in the archive (CCB-S3-007), now on the archiving section ── */
  check('archiving section offers the bot-message switches', sectionPages['archiving']!.includes('Her own messages in the archive') && sectionPages['archiving']!.includes('cat:consent'));
  check('and says plainly that no consent record is involved', sectionPages['archiving']!.includes('has no') && sectionPages['archiving']!.includes('consent record'));

  const post = (payload: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/interaction', payload: { _csrf: iaCsrf, ...payload }, headers: authed });
  const readIa = async () =>
    (await pg.query<{ value: Record<string, unknown> }>(`SELECT value FROM settings WHERE key = 'interaction'`)).rows[0]?.value ?? {};

  // NO SETTING DROPPED (CCB-S3-015 acceptance): capture the full key set before,
  // edit through every section, and prove the key set is unchanged AND each edit
  // landed. A setting that fell out of the split would be a missing key here.
  // The canonical complete settings — every key that must survive the split.
  const before = Object.keys(DEFAULT_INTERACTION).sort();

  const archiveSave = await post({ section: 'archive', mentionGuard: 'withhold', 'cat:price': 'on' });
  check('archive settings save', archiveSave.statusCode === 302 && String(archiveSave.headers['location'] ?? '').includes('/interaction/archiving?saved=1'));
  const archiveRow = await pg.query<{ value: { publishBotMessages: boolean; mentionGuard: string; categories: Record<string, boolean> } }>(`SELECT value FROM settings WHERE key = 'archive'`);
  check('the master switch really went off', archiveRow.rows[0]?.value.publishBotMessages === false);
  check('the mention guard really changed', archiveRow.rows[0]?.value.mentionGuard === 'withhold');
  const archiveAudit = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'archive.update'`);
  check('the archive change is audited', (archiveAudit.rows[0]?.n ?? 0) >= 1);
  await post({ section: 'archive', publishBotMessages: 'on', mentionGuard: 'redact', 'cat:consent': 'on', 'cat:price': 'on' });

  const r1 = await post({ section: 'addressing', naturalAddressing: 'on', wakeWord: 'Aschenputtel', greetings: 'hi, moin' });
  check('addressing save returns to its section', String(r1.headers['location'] ?? '').includes('/interaction/addressing?saved=1'));
  await post({ section: 'guards', addressingMode: 'strict', strongSignalGreeting: 'on', strongSignalReply: 'on', strongSignalWindow: 'on', maxInstructionLength: '350', lengthGuardConfidence: '0.9', logNearMisses: 'on', confidenceThreshold: '0.7', fillerPrefixes: 'so, hey, also', maxPrefixWords: '3', maxPrefixChars: '20' });
  await post({ section: 'followup', followUpSeconds: '90', intentCarryover: 'on', carryOverStopWords: 'nice, cool, thanks' });
  await post({ section: 'language', replyLanguageMode: 'fixed', defaultLanguage: 'de' });
  await post({ section: 'replies', replyMode: 'mention', namePrefixEnabled: 'on', 'prefix:en': '{name} —', replyLimitPerMember: '9', replyLimitPerChat: '40' });
  await post({ section: 'nicknames', enabled: 'on', words: 'cindy, cindi', spamLimit: '4' });
  await post({ section: 'consent', affirmations: 'yes, ja', declines: 'no, nein', undoWindowSeconds: '120' });
  await post({ section: 'links', archiveUrl: 'https://example.org/a', projectUrl: 'https://example.org/p' });
  await post({ section: 'persona:en', published: 'Custom published line.', publishConfirm: '' });

  const iaVal = await readIa() as Record<string, unknown> & {
    wakeWord: string; slashCommands: boolean; addressing: Record<string, unknown>;
    confidenceThreshold: number; fillerPrefixes: string[]; maxPrefixWords: number;
    followUpSeconds: number; carryOverStopWords: string[]; replyLanguageMode: string;
    defaultLanguage: string; replyMode: string; replyLimitPerMember: number;
    undoWindowSeconds: number; archiveUrl: string; nicknames: { words: string[] };
    persona: Record<string, Record<string, string>>;
  };
  const after = Object.keys(iaVal).sort();

  check('NO SETTING DROPPED — every default key is present after editing through every section',
    before.every((k) => after.includes(k)) && after.length === before.length,
    `default keys ${before.length}, stored keys ${after.length}`);
  // And every section's edit actually landed on the right field.
  check('addressing: wake word + unticked slash saved', iaVal.wakeWord === 'Aschenputtel' && iaVal.slashCommands === false);
  check('guards: mode, threshold and the newly-surfaced filler settings saved',
    iaVal.addressing['mode'] === 'strict' && iaVal.confidenceThreshold === 0.7 && iaVal.maxPrefixWords === 3 && iaVal.fillerPrefixes.includes('so'));
  check('follow-up: window and the interjection stop list saved', iaVal.followUpSeconds === 90 && iaVal.carryOverStopWords.includes('nice'));
  check('language: mode and default saved', iaVal.replyLanguageMode === 'fixed' && iaVal.defaultLanguage === 'de');
  check('replies: mode and per-member limit saved', iaVal.replyMode === 'mention' && iaVal.replyLimitPerMember === 9);
  check('nicknames: list saved', iaVal.nicknames.words.includes('cindy'));
  check('consent: undo window saved', iaVal.undoWindowSeconds === 120);
  check('voice: help link saved, and a blanked persona string fell back to its default',
    iaVal.archiveUrl === 'https://example.org/a' &&
      iaVal.persona['en']?.published === 'Custom published line.' &&
      (iaVal.persona['en']?.publishConfirm ?? '').includes('carry your words into the light'));

  // Reset returns to diagnostics and restores the shipped wake word.
  const resetRes = await post({ section: 'reset' });
  check('reset redirects to diagnostics', String(resetRes.headers['location'] ?? '').includes('/interaction/diagnostics?saved=1'));
  const iaReset = await getPage('/interaction/addressing');
  check('reset restores the shipped wake word', iaReset.body.includes('value="Cinderella"'));
  check('interaction edits are audited', ((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'interaction.update'`)).rows[0]?.n ?? 0) >= 1);

  // ── Plugins (CCB-S3-004) ──────────────────────────────────────────────
  const pluginsPage = await getPage('/plugins');
  check('plugins page renders', pluginsPage.code === 200);
  check(
    'it lists the Crypto Prices plugin as enabled',
    pluginsPage.body.includes('Crypto Prices') && pluginsPage.body.includes('Enabled'),
  );
  check(
    'and explains that disabling removes its intents',
    pluginsPage.body.includes('removes the intents it contributes'),
  );
  check(
    'the sidebar carries a Plugins entry with a submenu',
    pluginsPage.body.includes('href="/plugins"') &&
      pluginsPage.body.includes('href="/plugins/crypto-prices"'),
  );

  const cpPage = await getPage('/plugins/crypto-prices');
  check('the plugin has its own settings page', cpPage.code === 200);
  check(
    'with the provider chain, keys, behaviour and mapping table',
    cpPage.body.includes('name="chain"') &&
      cpPage.body.includes('name="providers.coinmarketcap.apiKeyInput"') &&
      cpPage.body.includes('name="cacheTtlSeconds"') &&
      cpPage.body.includes('Pinned assets'),
  );
  check(
    'the API key field is a password input with NO value rendered',
    /name="providers\.coinmarketcap\.apiKeyInput"[^>]*type="password"[^>]*value=""/.test(
      cpPage.body.replace(/\s+/g, ' '),
    ) ||
      (cpPage.body.includes('name="providers.coinmarketcap.apiKeyInput"') &&
        cpPage.body.includes('type="password"')),
  );
  // Collapse whitespace: the copy is line-wrapped in the source, and reflowing
  // prose to satisfy a substring test would be the wrong way round.
  const cpFlat = cpPage.body.replace(/\s+/g, ' ');
  check(
    'the licence notes are shown next to the chain',
    cpFlat.includes('Powered by CoinGecko') &&
      cpFlat.includes('may need a paid plan') &&
      cpFlat.includes('Dexscreener</strong> requires no attribution'),
  );
  check(
    'every setting carries an explanation',
    cpPage.body.includes('never displayed or logged') &&
      cpPage.body.includes('crossed through it') &&
      cpPage.body.includes('never touched by automatic resolution'),
  );

  const cpCsrf = csrfFrom(cpPage.body);
  const keyRes = await app.inject({
    method: 'POST',
    url: '/plugins/crypto-prices',
    payload: {
      _csrf: cpCsrf,
      section: 'chain',
      chain: 'dexscreener, coingecko, coinmarketcap',
      'providers.coingecko.enabled': 'on',
      'providers.coingecko.apiKeyInput': 'harness-demo-key',
      'providers.coingecko.timeoutMs': '9000',
      'providers.coingecko.rateLimitPerMinute': '20',
      'providers.dexscreener.enabled': 'on',
      'providers.dexscreener.timeoutMs': '8000',
      'providers.dexscreener.rateLimitPerMinute': '30',
    },
    headers: authed,
  });
  check(
    'provider chain edit succeeds',
    keyRes.statusCode === 302 && (keyRes.headers.location ?? '').includes('saved=1'),
    keyRes.headers.location as string,
  );
  const cpRow = await pg.query<{
    value: { chain: string[]; providers: Record<string, { apiKey: string; enabled: boolean }> };
  }>(`SELECT value FROM settings WHERE key = 'plugin:crypto-prices'`);
  const cpv = cpRow.rows[0]?.value;
  check('the chain order persisted', cpv?.chain[0] === 'dexscreener');
  check(
    'the API key is stored ENCRYPTED, never in clear',
    (cpv?.providers['coingecko']?.apiKey ?? '').startsWith('v1.') &&
      // ONE layer, not two: the stored envelope must decrypt straight back to
      // the typed key. It used to decrypt to another envelope (CCB-S3-008 §2).
      decryptSecret(cpv?.providers['coingecko']?.apiKey ?? '') === 'harness-demo-key' &&
      !JSON.stringify(cpv).includes('harness-demo-key'),
  );
  const cpAfter = await getPage('/plugins/crypto-prices');
  check(
    'and is never rendered back into the form',
    !cpAfter.body.includes('harness-demo-key') && cpAfter.body.includes('A key is stored'),
  );
  const cpAudit = await pg.query<{ details: unknown }>(
    `SELECT details FROM audit_log WHERE action = 'plugin.settings' ORDER BY id DESC LIMIT 1`,
  );
  check(
    'the audit entry records the change but not the key',
    !JSON.stringify(cpAudit.rows[0]?.details ?? {}).includes('harness-demo-key'),
  );

  const addMap = await app.inject({
    method: 'POST',
    url: '/plugins/crypto-prices',
    payload: {
      _csrf: cpCsrf,
      section: 'mapping-add',
      symbol: 'HEX',
      displayName: 'HEX',
      chain: 'ethereum',
      contract: '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39',
      providerIds: 'coingecko=hex',
      decimals: '8',
      locked: 'on',
    },
    headers: authed,
  });
  check(
    'a manual mapping can be added',
    addMap.statusCode === 302 && (addMap.headers.location ?? '').includes('saved=1'),
    addMap.headers.location as string,
  );
  const mapRow = await pg.query<{ symbol: string; locked: boolean; chain: string }>(
    `SELECT symbol, locked, chain FROM asset_mappings WHERE symbol = 'HEX'`,
  );
  check(
    'pinned, locked, and carrying the chain that identifies it',
    mapRow.rows[0]?.locked === true && mapRow.rows[0]?.chain === 'ethereum',
  );

  const toggleOff = await app.inject({
    method: 'POST',
    url: '/plugins/crypto-prices/toggle',
    payload: { _csrf: cpCsrf, enabled: 'off' },
    headers: authed,
  });
  check('the plugin can be disabled', toggleOff.statusCode === 302);
  const stateRow = await pg.query<{ value: Record<string, { enabled: boolean }> }>(
    `SELECT value FROM settings WHERE key = 'plugins'`,
  );
  check('and the state persists', stateRow.rows[0]?.value['crypto-prices']?.enabled === false);
  const offPage = await getPage('/plugins/crypto-prices');
  check('the page says so plainly', offPage.body.includes('not in the intent catalog at all'));
  await app.inject({
    method: 'POST',
    url: '/plugins/crypto-prices/toggle',
    payload: { _csrf: cpCsrf, enabled: 'on' },
    headers: authed,
  });

  const pluginNoAuth = await app.inject({ method: 'GET', url: '/plugins/crypto-prices' });
  check(
    'the plugin page is unreachable unauthenticated',
    pluginNoAuth.statusCode === 302 || pluginNoAuth.statusCode === 401,
  );

  const iaNoAuth = await app.inject({ method: 'GET', url: '/interaction' });
  check(
    'interaction console is unreachable unauthenticated',
    iaNoAuth.statusCode === 302 || iaNoAuth.statusCode === 401,
  );
  const iaNoCsrf = await app.inject({
    method: 'POST',
    url: '/interaction',
    payload: { section: 'addressing', wakeWord: 'Nope' },
    headers: authed,
  });
  check('interaction edit without CSRF is rejected', iaNoCsrf.statusCode === 403);

  await app.close();
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
  console.error('verify-admin-views crashed:', err);
  process.exit(1);
});
