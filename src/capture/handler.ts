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
import { isPublicGroupChat, parseGroupMessage, type CapturedMessage } from './message.js';

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
  /**
   * Natural-language interaction (CCB-S3-002). Called for every non-command
   * message BEFORE persistence. Returning true means the message was spoken to
   * Cinderella rather than to the group — a control message, so it is not
   * archived. Returning false means ordinary content: persist as usual.
   */
  onInteraction?: (msg: CapturedMessage) => Promise<boolean>;
  /**
   * Called after {@link onInteraction} handled a message, so the archive can
   * record WHAT KIND of instruction it was (CCB-S3-009). The message has already
   * been persisted by then.
   */
  onInstruction?: (msg: CapturedMessage, category?: string) => Promise<void> | void;
  /**
   * Side-effect-free "was this addressed to the bot?" test, used on EDITS. An
   * edit must not re-run the dialogue, but an instruction aimed at the bot must
   * not be archived either.
   */
  isAddressed?: (msg: CapturedMessage) => boolean;
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
  /**
   * Whether `/publish` and `/unpublish` are currently recognised (CCB-S3-002 §7,
   * admin-toggleable). Read per message so the toggle takes effect live. Absent
   * means enabled, which keeps every existing caller behaving as before.
   */
  slashCommandsEnabled?: () => boolean;
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
  const commandFor = (msg: CapturedMessage): ConsentCommand | null => {
    if (opts.slashCommandsEnabled && !opts.slashCommandsEnabled()) return null;
    return msg.type === 'text' && !msg.file ? parseConsentCommand(msg.text) : null;
  };

  /**
   * Runs the interaction layer. A thrown hook must never take a message down
   * with it — on failure we fall back to treating the message as ordinary
   * content, which archives it rather than losing it.
   */
  const interacted = async (msg: CapturedMessage): Promise<boolean> => {
    if (!hooks.onInteraction) return false;
    try {
      return await hooks.onInteraction(msg);
    } catch (err) {
      log.error(
        `onInteraction hook failed for item ${msg.itemId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  };

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
        // Archived like anything else, under the `consent` category, which ships
        // EXCLUDED. Capturing it and then excluding it is what makes the
        // operator's switch mean something — dropping it at the door would leave
        // a setting with nothing behind it.
        await persist(msg);
        try {
          await hooks.onInstruction?.(msg, 'consent');
        } catch {
          // Best-effort classification; the row is already safely stored.
        }
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

      // CCB-S3-009: a member's question is that member's message.
      //
      // This used to `continue` when she handled the message, so every question
      // asked of her was discarded and the public archive showed her answers with
      // nothing above them. Now the message is ALWAYS archived, and what kind of
      // instruction it was is recorded alongside it — publication is decided by
      // consent and by the category table, which is where that decision belongs.
      //
      // Persist runs FIRST so the row exists before she answers: her reply is
      // linked to it, and the pair publishes or withholds together.
      const persisted = await persist(msg);
      const handled = await interacted(msg);
      if (handled) {
        try {
          await hooks.onInstruction?.(msg);
        } catch (err) {
          log.error(
            `onInstruction hook failed for item ${msg.itemId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        continue;
      }

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
    // Nor does it re-open a dialogue — but a message addressed to her is still
    // not archive content, so it is dropped rather than persisted.
    if (hooks.isAddressed?.(msg)) return;
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
      // CCB-S3-019: same gate as capture — a private support-scope deletion must
      // not be routed into archive bookkeeping (it never had a public row anyway).
      if (!isPublicGroupChat(aci.chatInfo)) continue;
      if (aci.chatInfo.type !== 'group') continue; // narrow (guaranteed above)
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
