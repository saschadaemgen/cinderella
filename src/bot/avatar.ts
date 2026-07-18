/**
 * Bot avatar handling (Connect & Go-Live C.3 + restart-proofing).
 *
 * `bot.run()` reconciles the profile at startup and does NOT carry the `image`
 * field, so it blanks any previously-set avatar on every restart. We therefore
 * re-apply the avatar idempotently on EVERY boot: read the active profile, and if
 * the image is missing or differs from the intended one, update the profile with
 * the FULL existing profile plus the image (a partial profile would blank
 * displayName/fullName).
 *
 * SimpleX profile images ride inside the profile message envelope (~15,610 bytes
 * encoded), so the avatar must be small — we downscale to a square JPEG and drop
 * quality until the data URI is comfortably under budget. JPEG (PNG renders
 * blurry). An oversized image is silently not propagated to members.
 */

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { api } from 'simplex-chat';
import { util } from 'simplex-chat';
import { log } from '../log.js';

type Chat = api.ChatApi;

/** Keep the data URI well under the ~15,610-byte profile envelope. */
const MAX_DATA_URI_CHARS = 12000;
const SIZES = [192, 160, 128];
const QUALITIES = [72, 64, 56, 48, 40];

/** Downscales an image to a small square JPEG data URI under the size budget. */
export async function buildAvatarDataUri(source: Buffer): Promise<string> {
  let best = '';
  for (const px of SIZES) {
    for (const quality of QUALITIES) {
      const buf = await sharp(source)
        .rotate() // honour EXIF orientation
        .resize(px, px, { fit: 'cover', position: 'centre' })
        .jpeg({ quality })
        .toBuffer();
      const uri = `data:image/jpg;base64,${buf.toString('base64')}`;
      best = uri;
      if (uri.length <= MAX_DATA_URI_CHARS) return uri;
    }
  }
  // Nothing fit the budget (unusual); return the smallest we produced.
  return best;
}

/**
 * Ensures the bot's SimpleX profile carries the avatar. Idempotent: only updates
 * when the stored image differs. Safe to call on every startup. No-op if the
 * avatar file is absent. Returns true if the image is present after the call.
 */
export async function ensureAvatar(chat: Chat, avatarPath: string): Promise<boolean> {
  let source: Buffer;
  try {
    source = await readFile(avatarPath);
  } catch {
    log.debug(`No avatar file at ${avatarPath}; leaving profile image as-is.`);
    return false;
  }

  const dataUri = await buildAvatarDataUri(source);
  const user = await chat.apiGetActiveUser();
  if (!user) {
    log.warn('Cannot apply avatar: no active SimpleX user.');
    return false;
  }
  const profile = util.fromLocalProfile(user.profile);

  if (profile.image === dataUri) {
    log.debug('Avatar already up to date.');
    return true;
  }

  // Full profile + image — never a partial (that would blank displayName/fullName).
  await chat.apiUpdateProfile(user.userId, { ...profile, image: dataUri });

  const after = await chat.apiGetActiveUser();
  const stored = after ? util.fromLocalProfile(after.profile).image : undefined;
  if (!stored || stored.length < 100) {
    log.error('Avatar update did not stick — profile image still empty after apiUpdateProfile.');
    return false;
  }
  log.info(
    `Avatar (re)applied on startup for "${profile.displayName}": ` +
      `${stored.length} char data URI stored (was ${profile.image ? 'different' : 'blank'}).`,
  );
  return true;
}
