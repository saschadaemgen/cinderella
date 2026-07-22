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
import { sendToChat } from './bot/send.js';
import { registerCapture } from './capture/handler.js';
import { makePersistenceHooks } from './capture/persist.js';
import { withBotCapture, type BotReplyMeta } from './capture/bot-message.js';
import { makeConsentHandler } from './consent/commands.js';
import { assertDbReachable, closePool, getPool } from './db/pool.js';
import { markInterruptedMediaReceipts } from './db/messages.js';
import { SettingsService } from './settings/service.js';
import { SecurityService } from './security/settings.js';
import { SiteService } from './site/settings.js';
import { ArchiveService } from './archive/settings.js';
import { InteractionService } from './interaction/settings.js';
import { InteractionEngine } from './interaction/engine.js';
import { activeResolverName } from './interaction/resolver.js';
import { PluginService } from './plugins/service.js';
import { CryptoPriceService } from './plugins/crypto-prices/service.js';
import { CRYPTO_PRICES_ID } from './plugins/crypto-prices/plugin.js';
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
  interaction: InteractionService,
  plugins: PluginService,
): Promise<BotHandle | null> {
  try {
    const botHandle = await startBot(cfg, { getFileTimeoutMs: () => settings.fileTimeoutMs });
    const hooks = makePersistenceHooks(cfg);

    /**
     * The one place her own messages become archive rows (CCB-S3-007). Both reply
     * paths — the dialogue engine and the slash commands — go through this, for
     * the same reason they already share one transport: two capture sites would
     * be two chances for her side of a conversation to go missing.
     *
     * The placeholder is read live from the persona settings, so an operator who
     * rewrites "that member" sees it take effect on the next reply.
     */
    const placeholderFor = (lang: string): string => {
      const p = interaction.get().persona;
      return (
        p[lang]?.redactedMember ??
        p[interaction.get().defaultLanguage]?.redactedMember ??
        p['en']?.redactedMember ??
        'that member'
      );
    };
    const sendAndArchive = (
      msg: Parameters<typeof sendToChat>[1],
      text: string,
      opts: { quote: boolean } & BotReplyMeta,
    ): Promise<void> =>
      withBotCapture(placeholderFor, (t, o: { quote: boolean }) =>
        sendToChat(botHandle.chat, msg, t, o),
      )(text, opts);

    // The engine is created below; the callback is late-bound so the slash path
    // can refresh the same follow-up window the engine owns.
    let noteReply: (g: number, m: string) => void = () => undefined;
    hooks.onCommand = makeConsentHandler(botHandle, interaction, (g, m) => noteReply(g, m), {
      send: sendAndArchive,
    });

    // Natural addressing (CCB-S3-002). The engine only ever decides and replies;
    // consent changes go through the same write path as the slash commands.
    // Market data, provided by the Crypto Prices plugin (CCB-S3-004). Every
    // setting is read live, so a chain reorder or a new API key takes effect on
    // the next question without a restart.
    const prices = new CryptoPriceService({
      db: getPool(),
      settings: () => plugins.getCryptoPrices(),
    });

    const engine = new InteractionEngine({
      db: getPool(),
      settings: () => interaction.get(),
      // Handed over only while the plugin is enabled; when it is off, PRICE is
      // not in the active intent catalog either, so this is belt and braces.
      // Handed over only while the plugin is enabled; when it is off, PRICE is
      // not in the active intent catalog either, so this is belt and braces.
      ...(plugins.isEnabled(CRYPTO_PRICES_ID) ? { prices } : {}),
      priceSettings: () => plugins.getCryptoPrices(),
      // Presentation is the engine's decision (CCB-S3-003); this is only the
      // transport. Both this and the slash-command path go through sendToChat,
      // so the two can never disagree about quoting again — and both now archive
      // what they send (CCB-S3-007).
      send: sendAndArchive,
    });
    noteReply = (g, m) => engine.noteExternalReply(g, m);
    hooks.onInteraction = (msg) => engine.handle(msg);
    hooks.isAddressed = (msg) => engine.isExplicitAddress(msg);

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

    registerCapture(botHandle, cfg, hooks, {
      targetGroupId,
      slashCommandsEnabled: () => interaction.get().slashCommands,
    });
    await reportGroups(botHandle, cfg);
    status.botRunning(groupNames);

    const ia = interaction.get();
    log.info(
      `Interaction layer: wake word "${ia.wakeWord}", natural addressing ` +
        `${ia.naturalAddressing ? 'on' : 'off'}, slash commands ${ia.slashCommands ? 'on' : 'off'}, ` +
        `plugins [${plugins
          .list()
          .map((p) => `${p.id}:${p.enabled ? 'on' : 'off'}`)
          .join(' ')}], ` +
        `reply mode "${ia.replyMode}"${ia.replyMode === 'mention' && !ia.namePrefix.enabled ? ' (name prefix off)' : ''}, ` +
        `resolver "${activeResolverName()}".`,
    );

    // A pin that no enabled provider can serve fails SILENTLY and forever
    // (CCB-S3-008 §2), which is strictly worse than having no pin, so it is
    // checked at boot and named in the log rather than waiting for a member to
    // ask and get "the markets are out of earshot".
    try {
      const pins = await prices.checkPins();
      const broken = pins.filter((p) => !p.ok);
      if (broken.length > 0) {
        const names = broken.map((p) => p.symbol).join(', ');
        log.warn(
          `Price: ${broken.length} of ${pins.length} pinned asset(s) cannot be served by any ` +
            `enabled provider — ${names}. They will fail every lookup until the chain, a key, ` +
            `or the pin is corrected.`,
        );
        status.error(
          `${broken.length} pinned asset(s) have no enabled provider that can serve them: ${names}.`,
        );
      } else {
        log.info(`Price: all ${pins.length} pinned asset(s) have an enabled provider.`);
      }
    } catch (err) {
      log.warn(
        `Price: could not check the pinned assets (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
    }

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
  const site = await SiteService.load(getPool());
  const archive = await ArchiveService.load(getPool());
  const interaction = await InteractionService.load(getPool());
  const plugins = await PluginService.load(getPool());

  // One process (A2): the admin web server and the capture worker together.
  const adminCfg = loadAdminConfig();
  const adminServer = await startAdminServer({
    db: getPool(),
    adminCfg,
    mediaRoot: cfg.mediaRoot,
    settings,
    security,
    site,
    archive,
    interaction,
    plugins,
    cfg,
    registerViews: registerAdminViews,
  });

  const botHandle = await startCaptureWorker(cfg, settings, interaction, plugins);
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
