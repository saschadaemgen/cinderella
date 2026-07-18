/**
 * One-step tool to set the bot's SimpleX profile avatar (Connect & Go-Live C.3).
 *
 *   # stop the service first (single-writer SimpleX DB), then:
 *   npm run avatar -- /path/to/avatar.jpg
 *   # then start the service again
 *
 * Note: the service also re-applies the avatar on every startup (bot.run blanks
 * it), reading it from AVATAR_PATH — so the normal path is just to place the
 * image there. This tool applies a specific file immediately and verifies it.
 */

import { api, core } from 'simplex-chat';
import { loadConfig } from '../config.js';
import { log, setLogLevel } from '../log.js';
import { ensureAvatar } from './avatar.js';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith('-')) {
    log.error('Usage: npm run avatar -- <path-to-image>  (jpg/png/webp)');
    process.exit(2);
  }

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  log.info('Opening SimpleX core to update the profile…');
  const chat = await api.ChatApi.init(
    { type: 'sqlite', filePrefix: cfg.simplexDbPrefix },
    core.MigrationConfirmation.YesUp,
  );
  await chat.startChat();
  try {
    const ok = await ensureAvatar(chat, file);
    if (!ok) {
      log.error('Avatar was not applied (file missing/unreadable or update did not stick).');
      process.exit(1);
    }
    log.info('✓ Avatar applied and verified. Start the service again.');
  } finally {
    await chat.stopChat().catch(() => undefined);
    await chat.close().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error(`Failed to set avatar: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
