/**
 * One-step tool to set the bot's SimpleX profile avatar (Addendum 2 A2.7 —
 * parked until the operator supplies the image).
 *
 *   # stop the service first (single-writer SimpleX DB), then:
 *   npm run avatar -- /path/to/avatar.png
 *   # then start the service again
 *
 * Reads the image, encodes it as a data URI, and updates the SimpleX profile
 * image in place (all other profile fields preserved). Applying the avatar is a
 * single command — no redeploy.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { api, core, util } from 'simplex-chat';
import { loadConfig } from '../config.js';
import { log, setLogLevel } from '../log.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith('-')) {
    log.error('Usage: npm run avatar -- <path-to-image>  (png/jpg/webp/gif)');
    process.exit(2);
  }
  const mime = MIME_BY_EXT[extname(file).toLowerCase()];
  if (!mime) {
    log.error(`Unsupported image type "${extname(file)}". Use png, jpg, webp, or gif.`);
    process.exit(2);
  }

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const bytes = await readFile(file);
  // SimpleX profile images are small; keep well under the protocol limit.
  if (bytes.byteLength > 256 * 1024) {
    log.warn(
      `Image is ${Math.round(bytes.byteLength / 1024)} KiB — SimpleX profile images should be small ` +
        '(a few KiB). Consider downscaling to ~128x128 before setting it.',
    );
  }
  const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;

  log.info('Opening SimpleX core to update the profile…');
  const chat = await api.ChatApi.init(
    { type: 'sqlite', filePrefix: cfg.simplexDbPrefix },
    core.MigrationConfirmation.YesUp,
  );
  await chat.startChat();
  try {
    const user = await chat.apiGetActiveUser();
    if (!user) {
      log.error('No active SimpleX user found — start the bot at least once first.');
      process.exit(1);
    }
    const profile = util.fromLocalProfile(user.profile);
    await chat.apiUpdateProfile(user.userId, { ...profile, image: dataUri });
    log.info(`✓ Avatar set for "${profile.displayName}". Start the service again.`);
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
