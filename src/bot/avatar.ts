/**
 * Bot avatar handling (Connect & Go-Live C.3, SDK-native).
 *
 * The avatar is carried IN the profile passed to `bot.run`: the SDK's
 * `updateBotUserProfile` (simplex-chat 6.5.4 `bot.ts`) deep-compares the config
 * profile against the stored one and, when `updateProfile` is true (the default),
 * calls `apiUpdateProfile(userId, profile)` with the FULL profile — image
 * included. So we simply include the image in the boot profile: the core sets it
 * on first run and self-heals it on any boot where it differs. (The earlier
 * `updateProfile:false` + separate re-apply fought the SDK: a profile WITHOUT an
 * image differed from the stored one WITH an image, so every boot blanked it.)
 *
 * `apiUpdateProfile` only notifies direct CONTACTS (the bot has none); existing
 * GROUP members receive the avatar only when the bot next sends a group message
 * — see flushAvatarToGroups.
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
 * Reads the avatar file and returns a size-budgeted `data:image/jpg;base64,…`
 * data URI to embed in the bot's `bot.run` profile, or `undefined` if no avatar
 * file is present (or it can't be read). The SDK then applies/self-heals it.
 */
export async function loadAvatarDataUri(avatarPath: string): Promise<string | undefined> {
  let source: Buffer;
  try {
    source = await readFile(avatarPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug(`No avatar file at ${avatarPath}; bot profile will carry no image.`);
    } else {
      // A staged-but-unreadable avatar (e.g. root-owned after `npm run avatar`, then
      // read as the service user gives EACCES) must not masquerade as "no avatar"
      // (CCB-S3-023): say plainly it is present but unreadable so it is diagnosable.
      log.warn(
        `Avatar at ${avatarPath} could not be read (${code ?? (err instanceof Error ? err.message : String(err))}); ` +
          `bot profile will carry no image. If a file is staged there, check its ownership/permissions.`,
      );
    }
    return undefined;
  }
  const dataUri = await buildAvatarDataUri(source);
  if (dataUri.length > MAX_DATA_URI_CHARS) {
    // Over the profile envelope — the core would silently not propagate it.
    log.warn(
      `Avatar data URI is ${dataUri.length} chars (> ${MAX_DATA_URI_CHARS}); ` +
        'it may not propagate to members. Use a simpler/smaller source image.',
    );
  }
  log.info(`Avatar loaded from ${avatarPath}: ${dataUri.length} char data URI.`);
  return dataUri;
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
