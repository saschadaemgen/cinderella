/**
 * One-time operator helper: join the archive group via a SimpleX link.
 *
 *   npm run connect -- "<simplex group link>"
 *
 * The bot and this helper share the same SimpleX DB (SIMPLEX_DB_PREFIX), so once
 * the join completes the membership persists — run this once, then start the bot
 * normally. Do NOT run this and the bot at the same time (single-writer DB).
 *
 * Introduce the bot at group inception: history is not backfillable (only new
 * messages, plus at most ~100 recent messages an admin shares on join, are
 * captured — briefing §10.1).
 */

import { loadConfig } from '../config.js';
import { log, setLogLevel } from '../log.js';
import { startBot } from './client.js';

async function main(): Promise<void> {
  const link = process.argv[2];
  if (!link || link.startsWith('-')) {
    log.error('Usage: npm run connect -- "<simplex group link>"');
    process.exit(2);
  }

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info('Starting core to join a group…');

  const botHandle = await startBot(cfg);

  botHandle.chat.on('userJoinedGroup', ({ groupInfo }) => {
    log.info(
      `✓ Joined group: ${groupInfo.localDisplayName}. You can Ctrl+C and start the bot now.`,
    );
  });
  botHandle.chat.on('groupUpdated', ({ toGroup }) => {
    log.info(`Group updated: ${toGroup.localDisplayName}`);
  });

  log.info(`Connecting via link…`);
  const kind = await botHandle.chat.apiConnectActiveUser(link);
  log.info(
    `Connection initiated (${kind}). Waiting for the group handshake to complete — ` +
      'keep this running until you see "Joined group", then Ctrl+C.',
  );

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      log.info(`Received ${signal}, closing…`);
      botHandle
        .close()
        .catch(() => undefined)
        .finally(() => resolve());
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
