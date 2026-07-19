/**
 * Local admin-console preview: boots the REAL server with the REAL views on
 * 127.0.0.1:8788 against an in-process PGlite database seeded with placeholder
 * data — no live PostgreSQL, no SimpleX core, no secrets.
 *
 *   npx tsx scripts/admin-preview.ts
 *   -> http://127.0.0.1:8788  (user: operator, password: preview-password)
 *
 * DEV ONLY. Uses fixed placeholder credentials and seeded fake data; never run
 * on a public host.
 */

import { PGlite } from '@electric-sql/pglite';
import argon2 from 'argon2';
import { buildServer, registerNav } from '../src/web/server.js';
import { registerAdminViews } from '../src/web/views/index.js';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { recordMediaError, updateMedia, upsertMessage } from '../src/db/messages.js';
import { recordOptIn } from '../src/db/consent.js';
import { SettingsService } from '../src/settings/service.js';
import { SecurityService } from '../src/security/settings.js';
import type { Queryable } from '../src/db/pool.js';
import type { AdminConfig, Config } from '../src/config.js';

const PORT = Number(process.env['PREVIEW_PORT']) || 8788;
const PASSWORD = 'preview-password';

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

  // --- Seed placeholder data (never real member data) ---
  const A = 'member-alice-0000000000000000';
  const B = 'member-bob-00000000000000000';
  await recordOptIn(db, A, '2026-07-10T08:00:00Z');

  const seed = (id: number, member: string, type: string, text: string | null, sentAt: string) =>
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

  await seed(
    1,
    A,
    'text',
    'The pumpkin carriage departs at midnight sharp.',
    '2026-07-14T09:00:00Z',
  );
  await seed(
    2,
    A,
    'link',
    'Coverage of the royal ball: https://gazette.example/royal-ball',
    '2026-07-14T10:00:00Z',
  );
  await seed(
    3,
    B,
    'text',
    'Bob has not opted in, so this stays unpublished.',
    '2026-07-14T11:00:00Z',
  );
  await seed(4, A, 'image', null, '2026-07-15T12:00:00Z');
  await updateMedia(db, 1, 4, {
    mediaPath: '2026/07/4-placeholder.jpg',
    mediaMime: 'image/jpeg',
    mediaSize: 20480,
  });
  await seed(5, A, 'file', null, '2026-07-13T08:00:00Z');
  await recordMediaError(db, 1, 5, 'XFTP relay AUTH error (seeded example)');
  // Alice consented on 2026-07-10; this predates it, so it stays unpublished
  // (forward-only) — exercises the "sent before opt-in" reason.
  await seed(
    6,
    A,
    'text',
    'Posted before Alice opted in — stays unpublished.',
    '2026-07-08T09:00:00Z',
  );

  const adminCfg: AdminConfig = {
    adminPort: PORT,
    adminUsername: 'operator',
    adminPasswordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    sessionSecret: 'preview-session-secret-0123456789abcdef0123456789',
    publicOrigin: 'https://cinderella.example.org',
    rpId: 'cinderella.example.org',
    webauthnOrigin: 'https://cinderella.example.org',
    rpName: 'Cinderella Admin',
  };
  const cfg: Config = {
    botDisplayName: 'Cinderella',
    simplexDbPrefix: './state/simplex/cinderella',
    simplexFilesFolder: './state/files',
    groupName: 'cinderella-test',
    mediaRoot: process.cwd(),
    avatarPath: '',
    databaseUrl: 'postgres://cinderella:placeholder@127.0.0.1:5432/cinderella',
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
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`Admin preview: http://127.0.0.1:${PORT}  (operator / ${PASSWORD})`);
}

main().catch((err: unknown) => {
  console.error('admin-preview crashed:', err);
  process.exit(1);
});
