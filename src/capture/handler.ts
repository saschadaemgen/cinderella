/**
 * Wires the SimpleX `newChatItems` event into Cinderella's capture pipeline:
 * parse each item, drop non-group / non-message items, optionally scope to a
 * single group, hand the message to the caller's hooks, and (non-blocking)
 * receive any attached file.
 *
 * The hooks let each stage plug in its own behaviour without changing this
 * wiring: Stage 1 logs, Stage 2 persists, etc.
 */

import type { Config } from '../config.js';
import { log } from '../log.js';
import type { BotHandle } from '../bot/client.js';
import type { ReceivedFile } from '../bot/files.js';
import { parseConsentCommand, type ConsentCommand } from '../consent/commands.js';
import { parseGroupMessage, type CapturedMessage } from './message.js';

export interface CaptureHooks {
  /** Called for every captured group message (before any file is received). */
  onMessage: (msg: CapturedMessage) => Promise<void> | void;
  /** Called once an attached file finishes downloading. */
  onFileReceived?: (msg: CapturedMessage, file: ReceivedFile) => Promise<void> | void;
  /** Called if an attached file fails to download (timeout, XFTP error, …). */
  onFileFailed?: (msg: CapturedMessage, error: Error) => Promise<void> | void;
  /**
   * Called for a recognised consent command instead of onMessage — command
   * messages are control messages, not archive content, so they are not
   * persisted.
   */
  onCommand?: (msg: CapturedMessage, command: ConsentCommand) => Promise<void> | void;
  /** Called when messages are deleted in-group (by SimpleX group_msg_id). */
  onDeleted?: (groupId: number, groupMsgIds: number[]) => Promise<void> | void;
}

async function receiveAndReport(
  msg: CapturedMessage,
  botHandle: BotHandle,
  hooks: CaptureHooks,
): Promise<void> {
  if (!msg.file) return;
  try {
    const received = await botHandle.fileReceiver.receive(msg.file);
    await hooks.onFileReceived?.(msg, received);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (hooks.onFileFailed) {
      await hooks.onFileFailed(msg, error);
    } else {
      log.warn(`File receipt failed for message ${msg.itemId}: ${error.message}`);
    }
  }
}

async function runDeleted(hooks: CaptureHooks, groupId: number, ids: number[]): Promise<void> {
  if (ids.length === 0 || !hooks.onDeleted) return;
  try {
    await hooks.onDeleted(groupId, ids);
  } catch (err) {
    log.error(
      `onDeleted hook failed for group ${groupId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Registers the capture handlers on the bot. Idempotent per BotHandle — call once.
 * Handles new messages (persist), consent commands, and in-group deletions.
 */
export function registerCapture(botHandle: BotHandle, cfg: Config, hooks: CaptureHooks): void {
  botHandle.chat.on('newChatItems', async ({ chatItems }) => {
    for (const aChatItem of chatItems) {
      const msg = parseGroupMessage(aChatItem);
      if (!msg) continue;
      if (cfg.groupName && msg.groupName !== cfg.groupName) continue;

      // Consent commands are control messages — handle and do NOT persist.
      const command = parseConsentCommand(msg.text);
      if (command) {
        if (hooks.onCommand) {
          try {
            await hooks.onCommand(msg, command);
          } catch (err) {
            log.error(
              `onCommand hook failed for item ${msg.itemId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        continue;
      }

      try {
        await hooks.onMessage(msg);
      } catch (err) {
        log.error(
          `onMessage hook failed for item ${msg.itemId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Receive attached files without blocking the event loop.
      if (msg.file) {
        void receiveAndReport(msg, botHandle, hooks);
      }
    }
  });

  // In-group deletions: mirror SimpleX's channel webpage — deleted messages are
  // never published. Both events can fire for one deletion; markDeleted is
  // idempotent.
  botHandle.chat.on('groupChatItemsDeleted', async (ev) => {
    if (cfg.groupName && ev.groupInfo.localDisplayName !== cfg.groupName) return;
    await runDeleted(hooks, ev.groupInfo.groupId, ev.chatItemIDs);
  });

  botHandle.chat.on('chatItemsDeleted', async (ev) => {
    const byGroup = new Map<number, number[]>();
    for (const deletion of ev.chatItemDeletions) {
      const aci = deletion.deletedChatItem;
      if (aci.chatInfo.type !== 'group') continue;
      const groupInfo = aci.chatInfo.groupInfo;
      if (cfg.groupName && groupInfo.localDisplayName !== cfg.groupName) continue;
      const ids = byGroup.get(groupInfo.groupId) ?? [];
      ids.push(aci.chatItem.meta.itemId);
      byGroup.set(groupInfo.groupId, ids);
    }
    for (const [groupId, ids] of byGroup) {
      await runDeleted(hooks, groupId, ids);
    }
  });
}
