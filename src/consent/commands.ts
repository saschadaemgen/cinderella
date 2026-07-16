/**
 * Consent commands: `/publish` and `/unpublish` (ASCII only, briefing §9).
 *
 * Commands arrive as plain group messages to the bot. On `/publish` the sender's
 * stable member id is recorded as opted-in; on `/unpublish` it is revoked. Every
 * confirmation reply states what publishing means and how to revoke.
 */

import { log } from '../log.js';
import { getPool } from '../db/pool.js';
import { recordOptIn, recordOptOut } from '../db/consent.js';
import { status } from '../web/status.js';
import type { BotHandle } from '../bot/client.js';
import type { CapturedMessage } from '../capture/message.js';

export type ConsentCommand = 'publish' | 'unpublish';

/** Recognizes an exact `/publish` or `/unpublish` command (ASCII, trimmed). */
export function parseConsentCommand(text: string): ConsentCommand | null {
  const t = text.trim().toLowerCase();
  if (t === '/publish') return 'publish';
  if (t === '/unpublish') return 'unpublish';
  return null;
}

const PUBLISH_REPLY =
  "You're opted in. From now on, the messages you post in this group may appear " +
  'on the public web archive. This applies only to messages you send from this ' +
  'point onward - nothing you posted earlier. You can opt out at any time by ' +
  'sending /unpublish, which also removes your messages from the archive.';

const UNPUBLISH_REPLY =
  "You're opted out. Your messages will not appear on the public web archive, and " +
  'any of your messages that were published have been removed from it. You can opt ' +
  'in again at any time by sending /publish (only messages you send after opting ' +
  'in will be published).';

const FAILURE_REPLY =
  'Sorry - I could not process your command right now due to a temporary error. ' +
  'Please send it again in a moment.';

async function reply(botHandle: BotHandle, msg: CapturedMessage, text: string): Promise<void> {
  try {
    await botHandle.chat.apiSendTextReply(msg.raw, text);
  } catch (err) {
    log.warn(
      `Failed to send consent confirmation to member ${msg.senderMemberId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Builds the command handler used by the capture pipeline. Records consent and
 * replies with a confirmation.
 */
export function makeConsentHandler(
  botHandle: BotHandle,
): (msg: CapturedMessage, command: ConsentCommand) => Promise<void> {
  return async (msg, command) => {
    const db = getPool();
    try {
      if (command === 'publish') {
        await recordOptIn(db, msg.senderMemberId, msg.sentAt);
        log.info(`Consent: opt-in recorded for member ${msg.senderMemberId}.`);
        await reply(botHandle, msg, PUBLISH_REPLY);
      } else {
        const hadActive = await recordOptOut(db, msg.senderMemberId, msg.sentAt);
        log.info(
          `Consent: opt-out recorded for member ${msg.senderMemberId} (had active consent: ${hadActive}).`,
        );
        await reply(botHandle, msg, UNPUBLISH_REPLY);
      }
    } catch (err) {
      // Fail loudly toward the member and the operator — never silently drop a
      // consent decision (it is the product's legal backbone).
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Consent command /${command} failed for member ${msg.senderMemberId}: ${message}`);
      status.error(
        `Consent command /${command} failed for member ${msg.senderMemberId}: ${message}`,
      );
      await reply(botHandle, msg, FAILURE_REPLY);
    }
  };
}
