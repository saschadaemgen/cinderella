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
import { parseGroupMessage, type CapturedMessage } from './message.js';

export interface CaptureHooks {
  /** Called for every captured group message (before any file is received). */
  onMessage: (msg: CapturedMessage) => Promise<void> | void;
  /** Called once an attached file finishes downloading. */
  onFileReceived?: (msg: CapturedMessage, file: ReceivedFile) => Promise<void> | void;
  /** Called if an attached file fails to download (timeout, XFTP error, …). */
  onFileFailed?: (msg: CapturedMessage, error: Error) => Promise<void> | void;
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

/**
 * Registers the capture handler on the bot. Idempotent per BotHandle — call once.
 */
export function registerCapture(botHandle: BotHandle, cfg: Config, hooks: CaptureHooks): void {
  botHandle.chat.on('newChatItems', async ({ chatItems }) => {
    for (const aChatItem of chatItems) {
      const msg = parseGroupMessage(aChatItem);
      if (!msg) continue;
      if (cfg.groupName && msg.groupName !== cfg.groupName) continue;

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
}
