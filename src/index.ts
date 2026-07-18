/**
 * Cinderella entrypoint.
 *
 * Cinderella is the tireless worker: first into the group, never resting,
 * capturing everything opted-in members contribute so it can later be
 * republished as a consent-gated public archive.
 *
 *   node dist/index.js            → run the capture bot (long-lived)
 *   node dist/index.js --check    → validate config and exit 0 (Stage 0 check)
 *
 * Capture pipeline: connect the embedded SimpleX core, persist each received
 * group message to PostgreSQL (with extracted links and FTS), and download any
 * attached file into the media store, recording its path.
 */

import { loadAdminConfig, loadConfig, redactConfig, type Config } from './config.js';
import { log, setLogLevel } from './log.js';
import { startBot, type BotHandle } from './bot/client.js';
import { flushAvatarToGroups } from './bot/avatar.js';
import { registerCapture } from './capture/handler.js';
import { makePersistenceHooks } from './capture/persist.js';
import { makeConsentHandler } from './consent/commands.js';
import { assertDbReachable, closePool, getPool } from './db/pool.js';
import { markInterruptedMediaReceipts } from './db/messages.js';
import { SettingsService } from './settings/service.js';
import { SecurityService } from './security/settings.js';
import { startAdminServer } from './web/server.js';
import { status } from './web/status.js';
import { registerAdminViews } from './web/views/index.js';

function runConfigCheck(cfg: Config): void {
  log.info('Configuration loaded:', redactConfig(cfg));
  log.info('Config valid. Exiting 0.');
}

/** Ensures the archive DB is reachable and the schema has been migrated. */
async function assertDbReady(): Promise<void> {
  try {
    await assertDbReachable();
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL — check DATABASE_URL. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const { rows } = await getPool().query<{ t: string | null }>(
    `SELECT to_regclass('public.messages') AS t`,
  );
  if (!rows[0]?.t) {
    throw new Error('Archive schema is not initialized. Run: npm run migrate');
  }
}

/** Logs the groups the bot is currently a member of (capture only works there). */
async function reportGroups(botHandle: BotHandle, cfg: Config): Promise<void> {
  try {
    const groups = await botHandle.chat.apiListGroups(botHandle.user.userId);
    if (groups.length === 0) {
      log.warn(
        'Bot is not a member of any group yet. Join the archive group with: ' +
          'npm run connect -- "<simplex group link>"',
      );
      return;
    }
    const names = groups.map((g) => g.localDisplayName).join(', ');
    log.info(`Bot is in ${groups.length} group(s): ${names}`);
    if (cfg.groupName && !groups.some((g) => g.localDisplayName === cfg.groupName)) {
      log.warn(
        `GROUP_NAME="${cfg.groupName}" does not match any joined group; capture will be empty until the bot joins it.`,
      );
    }
  } catch (err) {
    log.warn(`Could not list groups: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Starts the capture worker. Failures are reported to the runtime status (so
 * the admin dashboard shows them) instead of killing the whole process — the
 * operator needs the console most when the bot is unhappy.
 */
async function startCaptureWorker(
  cfg: Config,
  settings: SettingsService,
): Promise<BotHandle | null> {
  try {
    const botHandle = await startBot(cfg, { getFileTimeoutMs: () => settings.fileTimeoutMs });
    const hooks = makePersistenceHooks(cfg);
    hooks.onCommand = makeConsentHandler(botHandle);

    // Resolve the configured group to its STABLE numeric id, so capture keeps
    // working if a group admin renames the group (display names are mutable).
    let targetGroupId: number | undefined;
    let groupNames: string[] = [];
    try {
      const groups = await botHandle.chat.apiListGroups(botHandle.user.userId);
      groupNames = groups.map((g) => g.localDisplayName);
      if (cfg.groupName) {
        const match = groups.find((g) => g.localDisplayName === cfg.groupName);
        if (match) targetGroupId = match.groupId;
      }
    } catch {
      // Non-fatal; fall back to name-based scoping.
    }

    registerCapture(botHandle, cfg, hooks, { targetGroupId });
    await reportGroups(botHandle, cfg);
    status.botRunning(groupNames);

    // Push the avatar to group members: the core only sends the member-profile
    // update (XInfo, incl. avatar) when the bot next sends a GROUP message. This
    // sends one minimal message per distinct avatar (marker-gated — no spam).
    try {
      await flushAvatarToGroups(botHandle.chat, getPool());
    } catch (err) {
      log.warn(`Avatar group-flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return botHandle;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.botFailed(message);
    status.error(`Capture worker failed to start: ${message}`);
    log.error(`Capture worker failed to start: ${message}`);
    return null;
  }
}

async function runApp(cfg: Config): Promise<void> {
  await assertDbReady();
  const settings = await SettingsService.load(getPool(), cfg.logLevel);

  // Any file receipt that was in-flight when the process last stopped is gone —
  // flag those messages so the operator sees them (before the ~48h XFTP expiry).
  const interrupted = await markInterruptedMediaReceipts(getPool());
  if (interrupted > 0) {
    log.warn(`${interrupted} media receipt(s) were interrupted by a previous restart — flagged.`);
  }

  const security = await SecurityService.load(getPool());

  // One process (A2): the admin web server and the capture worker together.
  const adminCfg = loadAdminConfig();
  const adminServer = await startAdminServer({
    db: getPool(),
    adminCfg,
    mediaRoot: cfg.mediaRoot,
    settings,
    security,
    cfg,
    registerViews: registerAdminViews,
  });

  const botHandle = await startCaptureWorker(cfg, settings);
  log.info('Cinderella is capturing to PostgreSQL (consent-gated). Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info(`Received ${signal}, shutting down…`);
      void (async () => {
        await adminServer.close().catch(() => undefined);
        if (botHandle) await botHandle.close().catch(() => undefined);
        await closePool().catch(() => undefined);
        resolve();
      })();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info('Cinderella booting…');

  if (process.argv.includes('--check')) {
    runConfigCheck(cfg);
    return;
  }

  await runApp(cfg);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Fatal: ${message}`);
    process.exit(1);
  });
