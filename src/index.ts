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
 * Stage 1 (proof of concept): connect the embedded SimpleX core, log each
 * received group message (sender member id + type + text), and download any
 * attached file to disk, confirming it landed and logging its path.
 */

import { stat } from 'node:fs/promises';
import { loadConfig, redactConfig, type Config } from './config.js';
import { log, setLogLevel } from './log.js';
import { startBot, type BotHandle } from './bot/client.js';
import { registerCapture } from './capture/handler.js';

function runConfigCheck(cfg: Config): void {
  log.info('Configuration loaded:', redactConfig(cfg));
  log.info('Config valid. Exiting 0.');
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

async function runBot(cfg: Config): Promise<void> {
  const botHandle = await startBot(cfg);

  registerCapture(botHandle, cfg, {
    onMessage: (msg) => {
      const preview = msg.text.length > 200 ? `${msg.text.slice(0, 200)}…` : msg.text;
      log.info(
        `[${msg.groupName}] message from member ${msg.senderMemberId} (${msg.senderDisplayName}): ` +
          `type=${msg.type}${msg.file ? ` file="${msg.file.fileName}" (${msg.file.fileSize} bytes)` : ''} ` +
          `text=${JSON.stringify(preview)}`,
      );
    },
    onFileReceived: async (msg, file) => {
      try {
        const info = await stat(file.path);
        if (info.size === 0) {
          log.warn(`Downloaded file is EMPTY: ${file.path} (${file.fileName}, item ${msg.itemId})`);
        } else {
          log.info(
            `Downloaded file for item ${msg.itemId}: ${file.path} (${info.size} bytes on disk) ✓`,
          );
        }
      } catch (err) {
        log.warn(
          `File reported complete but not found on disk: ${file.path} ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    },
    onFileFailed: (msg, error) => {
      log.warn(
        `File receipt FAILED for item ${msg.itemId} (${msg.file?.fileName}): ${error.message}`,
      );
    },
  });

  await reportGroups(botHandle, cfg);
  log.info('Cinderella is capturing. Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info(`Received ${signal}, shutting down…`);
      botHandle
        .close()
        .catch(() => undefined)
        .finally(() => resolve());
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

  await runBot(cfg);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Fatal: ${message}`);
    process.exit(1);
  });
