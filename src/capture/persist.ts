/**
 * Capture hooks backed by PostgreSQL: every captured message is persisted (with
 * extracted links and FTS text), and any attached file is moved into the media
 * store with its path recorded.
 */

import type { Config } from '../config.js';
import { log } from '../log.js';
import { getPool, withTransaction } from '../db/pool.js';
import {
  markDeleted,
  recordMediaError,
  replaceLinks,
  updateMedia,
  upsertMessage,
  type LinkInput,
} from '../db/messages.js';
import { status } from '../web/status.js';
import type { CaptureHooks } from './handler.js';
import { extractLinks, linksToSearchText } from './links.js';
import { storeMedia } from './media.js';
import { captureVideoLink } from './video.js';
import { messageIdFor, stripAndRecord } from '../media/pipeline.js';
import { enqueueDeletionRetry } from '../queue/index.js';

/** Message types that carry a downloadable file. */
const MEDIA_TYPES = new Set(['image', 'video', 'voice', 'file']);

export function makePersistenceHooks(cfg: Config): CaptureHooks {
  return {
    onMessage: async (msg) => {
      const extracted = extractLinks(msg);
      const linksText = linksToSearchText(extracted);
      const links: LinkInput[] = extracted.map((l) => ({
        url: l.url,
        title: l.title ?? null,
        description: l.description ?? null,
      }));

      let messageId: number;
      try {
        messageId = await withTransaction(async (db) => {
          const id = await upsertMessage(db, {
            groupId: msg.groupId,
            groupMsgId: msg.itemId,
            sharedMsgId: msg.sharedMsgId ?? null,
            senderMemberId: msg.senderMemberId,
            senderDisplayName: msg.senderDisplayName,
            sentAt: msg.sentAt,
            type: msg.type,
            textBody: msg.text.length > 0 ? msg.text : null,
            linksText,
            rawJson: msg.raw,
          });
          await replaceLinks(db, id, links);
          return id;
        });
      } catch (err) {
        // Surface on the dashboard and rethrow so the handler skips the file
        // receive (avoids moving media into the store with no row to point at).
        const message = err instanceof Error ? err.message : String(err);
        status.error(
          `Failed to persist message ${msg.itemId} from ${msg.senderMemberId}: ${message}`,
        );
        throw err;
      }

      status.captured();
      log.info(
        `Saved message ${messageId} [${msg.type}] from ${msg.senderMemberId}` +
          `${links.length ? ` (+${links.length} link(s))` : ''}` +
          `${msg.file ? ' — awaiting file' : ''}`,
      );

      // A media-type message with no file transfer can never be downloaded —
      // e.g. images shared as group history carry a preview thumbnail but no
      // file descriptor. Record it so it is not counted as a perpetually-pending
      // receipt on the dashboard.
      if (!msg.file && MEDIA_TYPES.has(msg.type)) {
        await recordMediaError(
          getPool(),
          msg.groupId,
          msg.itemId,
          'no downloadable file (shared without a file transfer — e.g. group history)',
        );
      }

      // A recognised video link becomes a click-to-play card (CCB-S3-014). Its
      // thumbnail is fetched once here and served locally, so the visitor's
      // browser reaches no third party before they click. Best-effort: a failure
      // never loses the message, only the thumbnail.
      try {
        await captureVideoLink(getPool(), cfg.mediaRoot, messageId, msg);
      } catch (err) {
        log.warn(
          `Video capture failed for message ${messageId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },

    onFileReceived: async (msg, file) => {
      const media = await storeMedia(file, msg, cfg.mediaRoot);
      const updated = await updateMedia(getPool(), msg.groupId, msg.itemId, media);
      if (updated === 0) {
        status.error(
          `Downloaded media for (group ${msg.groupId}, item ${msg.itemId}) but no message row ` +
            `exists — orphaned at ${media.mediaPath}. Persist likely failed earlier.`,
        );
        log.warn(
          `Orphaned media (no row): ${media.mediaPath} (group ${msg.groupId}, item ${msg.itemId})`,
        );
        return;
      }
      log.info(
        `Stored media for (group ${msg.groupId}, item ${msg.itemId}): ` +
          `${media.mediaPath} (${media.mediaSize} bytes, ${media.mediaMime}) ✓`,
      );

      // Strip immediately (CCB-S3-011 §1). Nothing is publishable until this has
      // run, so doing it here rather than lazily at first request means a photo
      // is never one cache-miss away from being served with its GPS intact.
      try {
        const id = await messageIdFor(getPool(), msg.groupId, msg.itemId);
        if (id !== null) {
          await stripAndRecord(getPool(), cfg.mediaRoot, id, media.mediaPath, media.mediaMime);
        }
      } catch (err) {
        log.error(
          `Could not strip metadata from ${media.mediaPath} (${
            err instanceof Error ? err.message : String(err)
          }); it will NOT be published until stripping succeeds.`,
        );
      }
    },

    onFileFailed: async (msg, error) => {
      log.warn(
        `File receipt failed for item ${msg.itemId} (${msg.file?.fileName}); ` +
          `row saved without media: ${error.message}`,
      );
      status.fileFailed({
        itemId: msg.itemId,
        groupId: msg.groupId,
        fileName: msg.file?.fileName ?? '(unknown)',
        reason: error.message,
      });
      await recordMediaError(getPool(), msg.groupId, msg.itemId, error.message);
    },

    onDeleted: async (groupId, groupMsgIds) => {
      try {
        const n = await markDeleted(getPool(), groupId, groupMsgIds);
        if (n > 0) {
          log.info(
            `Marked ${n} message(s) deleted in group ${groupId} (excluded from published set).`,
          );
        }
      } catch (err) {
        // The SDK delivers this deletion ONCE and never re-sends it, so a lost
        // markDeleted would leave member-deleted content published forever. Do not
        // lose it (CCB-S3-023): enqueue a DURABLE retry, applied when the DB
        // recovers, and make the alert ACTIONABLE rather than a banner nobody can
        // act on.
        const emsg = err instanceof Error ? err.message : String(err);
        const ids = groupMsgIds.join(', ');
        log.error(`markDeleted failed for group ${groupId} (items ${ids}): ${emsg}`);
        try {
          await enqueueDeletionRetry(getPool(), groupId, groupMsgIds);
          status.error(
            `In-group deletion for group ${groupId} message(s) ${ids} failed (${emsg}); queued for ` +
              `automatic retry. If it does not clear, it will appear in the queue dead-letters.`,
          );
        } catch (enqErr) {
          const q = enqErr instanceof Error ? enqErr.message : String(enqErr);
          status.error(
            `In-group deletion for group ${groupId} message(s) ${ids} FAILED and could not even be ` +
              `queued (${q}). Remove those messages by hand on the Messages page.`,
          );
        }
      }
    },
  };
}
