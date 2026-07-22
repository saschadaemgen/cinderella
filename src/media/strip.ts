/**
 * Metadata stripping for published media (CCB-S3-011 §1).
 *
 * A member consenting to publish their words is not consenting to publish the
 * coordinates of the room they were standing in. Consent covers the content; the
 * hidden payload was never part of the bargain.
 *
 * THREE RULES HOLD THIS TOGETHER.
 *
 * 1. The original is never touched. Stripping produces a DERIVATIVE, and only the
 *    derivative is ever served publicly. The archived original stays intact for
 *    the operator, for moderation, and for any preserve-and-report obligation —
 *    destroying evidence in the name of privacy helps nobody.
 *
 * 2. Orientation is applied to the PIXELS before the tag is discarded. `sharp`'s
 *    `.rotate()` with no argument does exactly this. Skip it and every photo that
 *    relied on the tag appears sideways — a "privacy fix" that visibly breaks the
 *    archive gets switched off, and then nothing is stripped at all.
 *
 * 3. What cannot be stripped is REPORTED, not silently passed through. This
 *    instance has no video or document stripper (that needs ffmpeg, which is not
 *    installed), so those formats are declared unstrippable and the operator is
 *    told, rather than being left to assume the guarantee covers everything.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import { log } from '../log.js';
import { readExifSummary, type ExifSummary } from './exif.js';

export interface StripResult {
  /** True when a derivative was written. */
  stripped: boolean;
  /** Path of the derivative relative to MEDIA_ROOT, when one was written. */
  derivedPath?: string;
  /** What the ORIGINAL contained, for the aggregate audit. Never values. */
  found: ExifSummary;
  /** Why nothing was written, when nothing was. */
  reason?: 'not-strippable-format' | 'decode-failed' | 'nothing-to-strip';
}

/** Formats this instance can actually strip. */
const STRIPPABLE_IMAGE = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
]);

/**
 * Can we strip this at all?
 *
 * Deliberately a positive list. "Anything not known to be dangerous" is the wrong
 * default for a privacy control: an unrecognised container gets declared
 * unstrippable and surfaces in the admin, instead of quietly being treated as
 * clean.
 */
export function isStrippable(mime: string | null): boolean {
  return mime !== null && STRIPPABLE_IMAGE.has(mime.toLowerCase());
}

/** Where a message's stripped derivative lives, relative to MEDIA_ROOT. */
export function derivedPathFor(messageId: number, originalRelPath: string): string {
  // Mirrors the original's date bucket so the tree stays navigable, but the name
  // is the message id — the same opaque identifier the public URL already uses,
  // so nothing about the member's own filename survives into the derived tree.
  const dir = dirname(originalRelPath);
  const ext = extname(originalRelPath).toLowerCase() || '.bin';
  return `derived/${dir}/${messageId}${ext}`;
}

/**
 * Writes a metadata-free copy of `relPath` for public serving.
 *
 * Returns what the original contained either way, so the caller can report the
 * aggregate without ever reading a value itself.
 */
export async function stripToDerivative(
  mediaRoot: string,
  relPath: string,
  messageId: number,
  mime: string | null,
): Promise<StripResult> {
  const absSource = join(mediaRoot, relPath);
  let source: Buffer;
  try {
    source = await readFile(absSource);
  } catch (err) {
    log.warn(
      `Media strip: could not read ${relPath} (${err instanceof Error ? err.message : String(err)}).`,
    );
    return { stripped: false, found: readExifSummary(Buffer.alloc(0)), reason: 'decode-failed' };
  }
  const found = readExifSummary(source);

  if (!isStrippable(mime)) {
    return { stripped: false, found, reason: 'not-strippable-format' };
  }

  const derivedRel = derivedPathFor(messageId, relPath);
  const absDest = join(mediaRoot, derivedRel);
  try {
    await mkdir(dirname(absDest), { recursive: true });
    // `.rotate()` with no argument bakes the EXIF orientation into the pixels.
    // Re-encoding without `withMetadata()` is what drops EXIF, IPTC and XMP —
    // sharp keeps metadata only when explicitly asked to.
    const out = await sharp(source, { failOn: 'none' })
      .rotate()
      .toBuffer();
    // Written to a temporary name and renamed, so a crash midway cannot leave a
    // truncated derivative that would then be served as though it were complete.
    const tmp = `${absDest}.tmp`;
    await writeFile(tmp, out);
    await rename(tmp, absDest);
    return { stripped: true, derivedPath: derivedRel, found };
  } catch (err) {
    log.warn(
      `Media strip: could not re-encode ${relPath} (${
        err instanceof Error ? err.message : String(err)
      }); the original will not be published.`,
    );
    return { stripped: false, found, reason: 'decode-failed' };
  }
}
