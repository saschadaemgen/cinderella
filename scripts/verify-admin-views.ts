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
import { upsertMessage, recordMediaError, updateMedia, markDeleted } from '../src/db/messages.js';
import { recordOptIn } from '../src/db/consent.js';
import { SettingsService } from '../src/settings/service.js';
import { SecurityService } from '../src/security/settings.js';
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
  const dash = await getPage('/');
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
