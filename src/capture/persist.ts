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

      const messageId = await withTransaction(async (db) => {
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

      status.captured();
      log.info(
        `Saved message ${messageId} [${msg.type}] from ${msg.senderMemberId}` +
          `${links.length ? ` (+${links.length} link(s))` : ''}` +
          `${msg.file ? ' — awaiting file' : ''}`,
      );
    },

    onFileReceived: async (msg, file) => {
      const media = await storeMedia(file, msg, cfg.mediaRoot);
      await updateMedia(getPool(), msg.groupId, msg.itemId, media);
      log.info(
        `Stored media for (group ${msg.groupId}, item ${msg.itemId}): ` +
          `${media.mediaPath} (${media.mediaSize} bytes, ${media.mediaMime}) ✓`,
      );
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
      const n = await markDeleted(getPool(), groupId, groupMsgIds);
      if (n > 0) {
        log.info(
          `Marked ${n} message(s) deleted in group ${groupId} (excluded from published set).`,
        );
      }
    },
  };
}
