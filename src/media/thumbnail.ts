/**
 * Obtaining a video thumbnail for local serving (CCB-S3-014 §2).
 *
 * The visitor's browser must reach NO third party before they click play, so the
 * thumbnail has to live on our own domain. Two sources, preferred in order:
 *
 *  1. The one SimpleX already delivered. A `link`-type message carries a base64
 *     preview image the SENDER's client generated (verified: `LinkPreview.image`).
 *     Using it means not one byte leaves our network — the best possible outcome.
 *  2. A one-time server-side fetch of the provider's thumbnail. OUR server
 *     reaches the provider, once, at capture; the visitor never does.
 *
 * Either way the bytes are written to the media store and then run through the
 * CCB-S3-011 strip pipeline like any other image, so a thumbnail that somehow
 * carried EXIF is cleaned too. If neither source yields a usable image, the
 * caller renders a neutral placeholder — it NEVER hotlinks the remote image,
 * which would be exactly the tracking this avoids.
 */

import { log } from '../log.js';

/** A decoded thumbnail ready to be written to disk. */
export interface ThumbnailBytes {
  data: Buffer;
  /** Best-guess extension from the content, for the stored filename. */
  ext: string;
}

const MAX_BYTES = 2 * 1024 * 1024; // a preview image; anything larger is suspect

/** Sniffs a small set of image signatures. Returns null for anything else. */
function imageExt(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return '.png';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return '.webp';
  }
  return null;
}

/**
 * Decodes a base64 (optionally data-URI) preview image from the wire. Returns
 * null when it is absent or not a recognised image — a broken preview is not a
 * reason to fail, the fetch fallback runs next.
 */
export function decodeWireThumbnail(image: string | undefined): ThumbnailBytes | null {
  if (!image) return null;
  const comma = image.indexOf(',');
  const b64 = image.startsWith('data:') && comma >= 0 ? image.slice(comma + 1) : image;
  try {
    const data = Buffer.from(b64, 'base64');
    if (data.length === 0 || data.length > MAX_BYTES) return null;
    const ext = imageExt(data);
    return ext ? { data, ext } : null;
  } catch {
    return null;
  }
}

/**
 * Fetches a thumbnail server-side, once. Bounded on time and size, and the
 * content is sniffed rather than trusted — this reaches a third-party host over
 * the network at capture time, so it is treated as hostile.
 */
export async function fetchThumbnail(
  url: string,
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<ThumbnailBytes | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'image/*' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    const ext = imageExt(buf);
    return ext ? { data: buf, ext } : null;
  } catch (err) {
    log.debug(`Thumbnail fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
