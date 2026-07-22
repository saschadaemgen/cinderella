/**
 * The one place a stripped derivative is produced and recorded (CCB-S3-011 §1).
 *
 * Both callers go through here — the capture path, which strips as soon as a file
 * lands, and the remediation script, which strips what was captured before this
 * existed. One function, so the two can never disagree about what "stripped"
 * means or about what gets written down.
 */

import { log } from '../log.js';
import type { Queryable } from '../db/pool.js';
import { isStrippable, stripToDerivative } from './strip.js';
import type { ExifSummary } from './exif.js';

/** Resolves a captured (group, item) to its archive row id. */
export async function messageIdFor(
  db: Queryable,
  groupId: number,
  groupMsgId: number,
): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM messages WHERE group_id = $1 AND group_msg_id = $2',
    [groupId, groupMsgId],
  );
  const id = rows[0]?.id;
  return id === undefined ? null : Number(id);
}

/** Only the flags — never a coordinate, a serial, or a name. */
function foundFlags(f: ExifSummary): Record<string, boolean> {
  return {
    exif: f.hasExif,
    gps: f.hasGps,
    camera: f.hasCamera,
    serial: f.hasSerial,
    owner: f.hasOwner,
    timestamp: f.hasTimestamp,
    software: f.hasSoftware,
    xmp: f.hasXmp,
    iptc: f.hasIptc,
    containerTags: f.hasContainerTags,
  };
}

export interface StripRecord {
  stripped: boolean;
  hadMetadata: boolean;
  hadGps: boolean;
  skipped: string | null;
}

/**
 * Strips one message's media and records the outcome.
 *
 * A format with no stripper is marked as such rather than left NULL: the serving
 * gate treats a NULL derivative as "not publishable", so without this an
 * unstrippable video would silently disappear from the archive instead of being
 * served with an honest note that its container tags could not be removed.
 */
export async function stripAndRecord(
  db: Queryable,
  mediaRoot: string,
  messageId: number,
  relPath: string,
  mime: string | null,
): Promise<StripRecord> {
  const result = await stripToDerivative(mediaRoot, relPath, messageId, mime);
  const hadMetadata =
    result.found.hasExif ||
    result.found.hasXmp ||
    result.found.hasIptc ||
    result.found.hasContainerTags;

  const skipped = result.stripped
    ? null
    : isStrippable(mime)
      ? // A strippable format that would not strip is a fault, not a policy. It
        // stays unpublishable until someone looks at it.
        null
      : 'no stripper for this format on this instance';

  await db.query(
    `UPDATE messages
        SET media_derived_path  = $2,
            media_meta_found    = $3::jsonb,
            media_strip_skipped = $4
      WHERE id = $1`,
    [messageId, result.derivedPath ?? null, JSON.stringify(foundFlags(result.found)), skipped],
  );

  if (result.found.hasGps) {
    // Worth a line of its own: this is the disclosure the feature exists to
    // prevent, and the operator should be able to see that it happened.
    log.warn(`Media: message ${messageId} carried GPS coordinates; the published copy does not.`);
  }
  return {
    stripped: result.stripped,
    hadMetadata,
    hadGps: result.found.hasGps,
    skipped,
  };
}
