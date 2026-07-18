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

import type { T } from '@simplex-chat/types';
import { loadConfig } from '../config.js';
import { log, setLogLevel } from '../log.js';
import { WELCOME_MESSAGE } from '../consent/commands.js';
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

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (why: string): void => {
      if (done) return;
      done = true;
      log.info(`${why} — closing.`);
      botHandle
        .close()
        .catch(() => undefined)
        .finally(() => resolve());
    };

    const welcomed = new Set<number>();
    botHandle.chat.on('userJoinedGroup', ({ groupInfo }) => {
      log.info(`✓ Joined group: ${groupInfo.localDisplayName}.`);
      if (welcomed.has(groupInfo.groupId)) return;
      welcomed.add(groupInfo.groupId);
      // Post the consent-first welcome message (A2.7 / §9), then exit so this
      // one-shot helper terminates cleanly (also works non-interactively).
      const chatInfo: T.ChatInfo = { type: 'group', groupInfo };
      botHandle.chat
        .apiSendTextMessage(chatInfo, WELCOME_MESSAGE)
        .then(() => log.info('Posted the consent-first welcome message to the group.'))
        .catch((err: unknown) =>
          log.warn(
            `Could not post welcome message: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => setTimeout(() => finish('Welcome posted'), 2500));
    });
    botHandle.chat.on('groupUpdated', ({ toGroup }) => {
      log.info(`Group updated: ${toGroup.localDisplayName}`);
    });

    log.info('Connecting via link…');
    botHandle.chat
      .apiConnectActiveUser(link)
      .then((kind) =>
        log.info(`Connection initiated (${kind}). Waiting for the group handshake to complete…`),
      )
      .catch((err: unknown) => {
        log.error(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
        finish('Connect error');
      });

    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGTERM', () => finish('SIGTERM'));
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
