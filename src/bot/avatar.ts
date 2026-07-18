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
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { api } from 'simplex-chat';
import { util } from 'simplex-chat';
import type { T } from '@simplex-chat/types';
import { log } from '../log.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { Queryable } from '../db/pool.js';

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
 * Ensures the bot's SimpleX profile carries an avatar.
 *
 * `apiUpdateProfile` writes the image and bumps `userMemberProfileUpdatedAt`, but
 * only SENDS the update to direct CONTACTS — group members receive it when the
 * bot next sends a GROUP message (see flushAvatarToGroups). Non-destructive on
 * boot: when called WITHOUT `force`, this only sets the image if one is MISSING,
 * so it never re-encodes/clobbers an image already on the profile. Pass `force`
 * (the `set-avatar` CLI) to set it deliberately.
 *
 * Returns true if the image is present after the call.
 */
export async function ensureAvatar(
  chat: Chat,
  avatarPath: string,
  force = false,
): Promise<boolean> {
  const user = await chat.apiGetActiveUser();
  if (!user) {
    log.warn('Cannot apply avatar: no active SimpleX user.');
    return false;
  }
  const profile = util.fromLocalProfile(user.profile);

  if (!force && profile.image && profile.image.length > 0) {
    // An image is already set (possibly by the desktop app) — leave it untouched.
    log.debug('Avatar already present on profile; leaving it as-is (non-destructive).');
    return true;
  }

  let source: Buffer;
  try {
    source = await readFile(avatarPath);
  } catch {
    log.debug(`No avatar file at ${avatarPath}; leaving profile image as-is.`);
    return false;
  }
  const dataUri = await buildAvatarDataUri(source);
  if (!force && profile.image === dataUri) {
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

/** Marker (in `settings`) recording which avatar has been flushed to the group. */
const FLUSH_MARKER_KEY = 'avatarGroupFlushMarker';
/** A minimal, one-time group message whose only job is to flush the profile. */
const FLUSH_MESSAGE = '🕯️✨';

/**
 * Flushes the bot's member profile (incl. avatar) to its groups.
 *
 * The SimpleX core only sends a member-profile update (`XInfo`) to a group when
 * the bot next sends a GROUP message — it piggybacks the profile when
 * `userMemberProfileSentAt < userMemberProfileUpdatedAt` (setting the avatar
 * advances the latter). `apiUpdateProfile` alone reaches contacts only, so
 * without a group send the avatar never reaches members.
 *
 * This sends ONE minimal group message per distinct avatar (gated by a hash
 * marker in `settings`, so restarts don't spam). After the send the core has
 * flushed the profile and won't re-piggyback; normal command replies keep it
 * current thereafter.
 */
export async function flushAvatarToGroups(chat: Chat, db: Queryable): Promise<void> {
  const user = await chat.apiGetActiveUser();
  if (!user) return;
  const image = util.fromLocalProfile(user.profile).image;
  if (!image) return; // nothing to flush

  const marker = createHash('sha256').update(image).digest('hex').slice(0, 16);
  const stored = await getSetting(db, FLUSH_MARKER_KEY);
  if (stored === marker) {
    log.debug('Avatar already flushed to groups; no group send needed.');
    return;
  }

  // Attempt every group; a non-connected group just errors and is skipped (the
  // GroupMemberStatus runtime value doesn't reliably match the typed enum, so we
  // don't pre-filter on it).
  const groups = await chat.apiListGroups(user.userId);
  let sent = 0;
  for (const g of groups) {
    try {
      const chatInfo: T.ChatInfo = { type: 'group', groupInfo: g };
      await chat.apiSendTextMessage(chatInfo, FLUSH_MESSAGE);
      sent++;
    } catch (err) {
      log.warn(
        `Could not flush profile to group ${g.localDisplayName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (sent > 0) {
    await setSetting(db, FLUSH_MARKER_KEY, marker);
    log.info(
      `Flushed member profile (avatar) to ${sent} group(s) via one group message — ` +
        'members receive the XInfo profile update on this send.',
    );
  }
}
