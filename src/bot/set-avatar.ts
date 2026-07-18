/**
 * One-step tool to set the bot's SimpleX profile avatar (Addendum 2 A2.7 / C.3).
 *
 *   # stop the service first (single-writer SimpleX DB), then:
 *   npm run avatar -- /path/to/avatar.jpg
 *   # then start the service again
 *
 * SimpleX profile images travel inside the profile broadcast, so they MUST be
 * small — a full-size photo is silently not applied/propagated. This tool always
 * downscales to a small square JPEG (data:image/jpg;base64,…) before setting it,
 * then re-reads the profile to VERIFY the image is actually stored (not just that
 * the command returned).
 */

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { api, core, util } from 'simplex-chat';
import { loadConfig } from '../config.js';
import { log, setLogLevel } from '../log.js';

// SimpleX-appropriate avatar: small square, well under the profile-size limit.
const AVATAR_PX = 192;
const AVATAR_QUALITY = 80;

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith('-')) {
    log.error('Usage: npm run avatar -- <path-to-image>  (jpg/png/webp)');
    process.exit(2);
  }

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const source = await readFile(file);
  // Downscale to a centred square JPEG. This is what makes the avatar actually
  // apply — SimpleX rejects/never-propagates oversized profile images.
  const resized = await sharp(source)
    .rotate() // honour EXIF orientation
    .resize(AVATAR_PX, AVATAR_PX, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: AVATAR_QUALITY })
    .toBuffer();
  const dataUri = `data:image/jpg;base64,${resized.toString('base64')}`;
  log.info(
    `Prepared avatar: ${AVATAR_PX}x${AVATAR_PX} JPEG, ${Math.round(resized.byteLength / 1024)} KiB ` +
      `(from ${Math.round(source.byteLength / 1024)} KiB source).`,
  );

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

    // VERIFY: re-read the active user and confirm the image is actually stored.
    const after = await chat.apiGetActiveUser();
    const storedImage = after ? util.fromLocalProfile(after.profile).image : undefined;
    if (!storedImage || storedImage.length < 100) {
      log.error(
        'Avatar update did not stick — the profile image is still empty after apiUpdateProfile. ' +
          'Aborting so this is not reported as success.',
      );
      process.exit(1);
    }
    log.info(
      `✓ Avatar verified on profile "${profile.displayName}" ` +
        `(${Math.round(storedImage.length / 1024)} KiB data URI stored). ` +
        'It broadcasts to group members; clients may cache the old image briefly. ' +
        'Start the service again.',
    );
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
