/**
 * Stages the bot's SimpleX profile avatar (Connect & Go-Live C.3).
 *
 *   npm run avatar -- /path/to/avatar.jpg
 *   # then restart the service to apply it
 *
 * The avatar is applied by the running service: `bot.run` carries the image in
 * the boot profile and the SDK's updateBotUserProfile sets/self-heals it (see
 * src/bot/avatar.ts). So this tool does NOT open the SimpleX core (which is a
 * single-writer DB the live service holds open) — it just validates the image
 * fits the profile envelope and copies it to AVATAR_PATH. Restart the service to
 * apply, and the boot-time group flush pushes it to existing members.
 */

import { copyFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveAvatarPath } from '../config.js';
import { log } from '../log.js';
import { buildAvatarDataUri } from './avatar.js';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith('-')) {
    log.error('Usage: npm run avatar -- <path-to-image>  (jpg/png/webp)');
    process.exit(2);
  }

  // Only the avatar path is needed — no DB/admin env (this never opens the core).
  const avatarPath = resolveAvatarPath();

  let source: Buffer;
  try {
    source = await readFile(file);
  } catch (err) {
    log.error(`Cannot read image ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Validate it downscales to a data URI within the profile envelope.
  const dataUri = await buildAvatarDataUri(source);
  log.info(`Prepared avatar: ${dataUri.length} char data URI (image/jpg).`);

  if (resolve(file) !== avatarPath) {
    await mkdir(dirname(avatarPath), { recursive: true });
    await copyFile(file, avatarPath);
    log.info(`Copied avatar to ${avatarPath}.`);
  } else {
    log.info(`Avatar already at ${avatarPath}.`);
  }

  log.info('✓ Avatar staged. Restart the service to apply it to the bot profile');
  log.info('  and flush it to existing group members (systemctl restart cinderella).');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error(`Failed to stage avatar: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
