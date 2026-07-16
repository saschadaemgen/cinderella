/**
 * Wires the SimpleX `newChatItems` (and edit/deletion) events into Cinderella's
 * capture pipeline: parse each item, drop non-group / non-message items,
 * optionally scope to a single group, hand the message to the caller's hooks,
 * and (non-blocking) receive any attached file.
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

export interface CaptureOptions {
  /**
   * Stable numeric group id to scope capture to. Preferred over GROUP_NAME
   * because the display name can be changed by a group admin (which would
   * otherwise silently stop capture). Resolved once at startup.
   */
  targetGroupId?: number | undefined;
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
    try {
      if (hooks.onFileFailed) {
        await hooks.onFileFailed(msg, error);
      } else {
        log.warn(`File receipt failed for message ${msg.itemId}: ${error.message}`);
      }
    } catch (hookErr) {
      // Never let a failing failure-handler escape (it would reject the detached
      // promise and crash the process on unhandledRejection).
      log.error(
        `onFileFailed hook threw for item ${msg.itemId}: ${
          hookErr instanceof Error ? hookErr.message : String(hookErr)
        }`,
      );
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
 * Handles new messages (persist), edits, consent commands, and in-group deletions.
 */
export function registerCapture(
  botHandle: BotHandle,
  cfg: Config,
  hooks: CaptureHooks,
  opts: CaptureOptions = {},
): void {
  /** Is this captured message in scope? Prefer the stable group id. */
  const inScope = (msg: CapturedMessage): boolean => {
    if (opts.targetGroupId != null) return msg.groupId === opts.targetGroupId;
    if (cfg.groupName) return msg.groupName === cfg.groupName;
    return true;
  };

  /** A consent command is ONLY a plain-text message with no attachment. */
  const commandFor = (msg: CapturedMessage): ConsentCommand | null =>
    msg.type === 'text' && !msg.file ? parseConsentCommand(msg.text) : null;

  const persist = async (msg: CapturedMessage): Promise<boolean> => {
    try {
      await hooks.onMessage(msg);
      return true;
    } catch (err) {
      log.error(
        `onMessage hook failed for item ${msg.itemId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  };

  botHandle.chat.on('newChatItems', async ({ chatItems }) => {
    for (const aChatItem of chatItems) {
      const msg = parseGroupMessage(aChatItem);
      if (!msg || !inScope(msg)) continue;

      // Consent commands are control messages — handle and do NOT persist.
      const command = commandFor(msg);
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

      const persisted = await persist(msg);

      // Only receive the file if the row exists — otherwise the media would be
      // moved into the store with no row to point at it (an orphan).
      if (persisted && msg.file) {
        void receiveAndReport(msg, botHandle, hooks);
      }
    }
  });

  // Edits: overwrite the stored content so pre-edit text is not left published.
  botHandle.chat.on('chatItemUpdated', async ({ chatItem }) => {
    const msg = parseGroupMessage(chatItem);
    if (!msg || !inScope(msg)) return;
    if (commandFor(msg)) return; // an edit does not (re)trigger a consent command
    await persist(msg);
  });

  // In-group deletions: mirror SimpleX's channel webpage — deleted messages are
  // never published. Not scoped by group name: markDeleted is keyed by
  // (group_id, group_msg_id) and is a no-op for uncaptured groups, so filtering
  // here would only risk dropping deletions after a group rename. Both events can
  // fire for one deletion; markDeleted is idempotent.
  botHandle.chat.on('groupChatItemsDeleted', async (ev) => {
    await runDeleted(hooks, ev.groupInfo.groupId, ev.chatItemIDs);
  });

  botHandle.chat.on('chatItemsDeleted', async (ev) => {
    const byGroup = new Map<number, number[]>();
    for (const deletion of ev.chatItemDeletions) {
      const aci = deletion.deletedChatItem;
      if (aci.chatInfo.type !== 'group') continue;
      const groupInfo = aci.chatInfo.groupInfo;
      const ids = byGroup.get(groupInfo.groupId) ?? [];
      ids.push(aci.chatItem.meta.itemId);
      byGroup.set(groupInfo.groupId, ids);
    }
    for (const [groupId, ids] of byGroup) {
      await runDeleted(hooks, groupId, ids);
    }
  });
}
