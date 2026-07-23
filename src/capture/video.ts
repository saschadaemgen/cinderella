/**
 * Turning a captured video link into a playable card (CCB-S3-014).
 *
 * Run once per message at capture: if any URL in the message is a recognised
 * video, record which provider/id/start/title it is, and obtain a thumbnail to
 * serve from our own domain. The thumbnail is stored as the message's own media
 * so it rides the CCB-S3-011 strip-and-serve pipeline unchanged.
 *
 * Ordering matches the briefing: prefer the thumbnail SimpleX already delivered
 * (nothing leaves our network), then a one-time server fetch, then nothing — in
 * which case the front draws a neutral placeholder rather than hotlinking.
 */

import { extname, join } from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { log } from '../log.js';
import type { Queryable } from '../db/pool.js';
import type { CapturedMessage } from './message.js';
import { extractLinks } from './links.js';
import { matchVideoUrl, type VideoMatch } from '../media/video.js';
import { decodeWireThumbnail, fetchThumbnail, type ThumbnailBytes } from '../media/thumbnail.js';
import { stripAndRecord } from '../media/pipeline.js';

/** Finds the first video link in a message, if any. */
export function firstVideoLink(msg: CapturedMessage): VideoMatch | null {
  // The link preview's own URL first (it is the one with a title/thumbnail),
  // then any URL found in the text body.
  const urls: string[] = [];
  if (msg.linkPreview?.url) urls.push(msg.linkPreview.url);
  for (const l of extractLinks(msg)) urls.push(l.url);
  for (const u of urls) {
    const hit = matchVideoUrl(u);
    if (hit) return hit;
  }
  return null;
}

/** The `YYYY/MM` bucket, mirroring storeMedia so the tree stays consistent. */
function bucket(sentAt: string): string {
  const d = new Date(sentAt);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${String(d.getUTCFullYear()).padStart(4, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Records a message's video link and stores its thumbnail locally.
 *
 * Returns true when a video was recorded. The thumbnail write is best-effort: a
 * card with no thumbnail still renders (placeholder), so a failed fetch must not
 * lose the video card itself.
 */
export async function captureVideoLink(
  db: Queryable,
  mediaRoot: string,
  messageId: number,
  msg: CapturedMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const match = firstVideoLink(msg);
  if (!match) return false;

  const title = msg.linkPreview?.title ?? null;
  await db.query(
    `UPDATE messages
        SET video_provider = $2, video_id = $3, video_start = $4, video_title = $5
      WHERE id = $1`,
    [messageId, match.provider, match.videoId, match.startSeconds, title],
  );

  // The thumbnail: wire image first, then a one-time fetch.
  let thumb: ThumbnailBytes | null = decodeWireThumbnail(msg.linkPreview?.image);
  let source = 'wire';
  if (!thumb) {
    thumb = await fetchThumbnail(match.thumbnailUrl, 8000, fetchImpl);
    source = 'fetch';
  }
  if (!thumb) {
    log.info(
      `Video: recorded ${match.provider} ${match.videoId} for message ${messageId}; no thumbnail (placeholder will render).`,
    );
    return true;
  }

  const rel = `${bucket(msg.sentAt)}/thumb-${messageId}${thumb.ext}`;
  const abs = join(mediaRoot, rel);
  try {
    await mkdir(join(mediaRoot, bucket(msg.sentAt)), { recursive: true });
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, thumb.data);
    await rename(tmp, abs);
    const mime =
      extname(rel) === '.png' ? 'image/png' : extname(rel) === '.webp' ? 'image/webp' : 'image/jpeg';
    await db.query('UPDATE messages SET media_path = $2, media_mime = $3, media_size = $4 WHERE id = $1', [
      messageId,
      rel,
      mime,
      thumb.data.length,
    ]);
    // Strip it like any other published image; the derivative is what serves.
    await stripAndRecord(db, mediaRoot, messageId, rel, mime);
    log.info(
      `Video: recorded ${match.provider} ${match.videoId} for message ${messageId}, thumbnail from ${source}.`,
    );
  } catch (err) {
    log.warn(
      `Video: could not store thumbnail for message ${messageId} (${
        err instanceof Error ? err.message : String(err)
      }); the card will use a placeholder.`,
    );
  }
  return true;
}
