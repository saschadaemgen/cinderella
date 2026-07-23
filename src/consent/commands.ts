/**
 * Consent commands: `/publish` and `/unpublish` (ASCII only, briefing §9).
 *
 * Commands arrive as plain group messages to the bot. On `/publish` the sender's
 * stable member id is recorded as opted-in; on `/unpublish` it is revoked. Every
 * confirmation reply states what publishing means and how to revoke.
 */

import { log } from '../log.js';
import { getPool } from '../db/pool.js';
import { applyConsentChange } from './apply.js';
import { status } from '../web/status.js';
import { sendToChat } from '../bot/send.js';
import { formatOutbound } from '../interaction/reply.js';
import { DEFAULT_INTERACTION, type InteractionSettings } from '../interaction/settings.js';
import type { BotHandle } from '../bot/client.js';
import type { CapturedMessage } from '../capture/message.js';
import type { BotReplyMeta } from '../capture/bot-message.js';

export type ConsentCommand = 'publish' | 'unpublish';

/**
 * The transport a consent confirmation is sent through. Matches the interaction
 * engine's `send`, so both reply paths archive her side the same way.
 */
export type ConsentSender = (
  msg: CapturedMessage,
  text: string,
  opts: { quote: boolean } & BotReplyMeta,
) => Promise<void>;

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

/**
 * Consent-first welcome message posted to the group on join (briefing §9,
 * Addendum 2 A2.7, Connect & Go-Live C.2). Cinderella's own voice; it is the
 * consent notice that does the legal work — posted verbatim. Do not paraphrase.
 *
 * NOTE (CCB-S3-003): an earlier version of this comment claimed SimpleX renders
 * no markdown. That is wrong, and believing it is what shipped literal asterisks
 * to the live group. SimpleX DOES render single-character delimiters — `*bold*`,
 * `_italic_`, `~strike~`, backtick code, `#secret#`. This message contains none,
 * so it is unaffected, but any copy added here must respect that.
 */
export const WELCOME_MESSAGE = `I'm Cinderella, and yes, I run this place.

Before you settle in, one thing you should know. By default, whatever you say here stays here, between us. I publish nothing of yours to the outside world unless you tell me to.

If you want your words to step into the light and join the public record, that is your call. Say so, and I will carry your messages, meaning your text, images, video and links, out to my public archive, a searchable page kept for good, with your name on it. From the moment you say yes, and only forward from there. Never behind your back.

Three things worth knowing before you decide.
Forward only: I only ever publish what you say after you opt in, never anything from before.
Public until you take it back: it stays on the web, and searchable, for as long as you leave it there.
Taking it back is final: /unpublish removes everything at once, and opting in again later starts fresh from that moment, it does not bring the old words back.

To let me publish for you, send /publish
To take it all back, send /unpublish
To see everything I can do, send /help

No /publish, and you simply talk freely. Nothing leaves this room. Your choice, always, and yours to change whenever you like.

Cinderella`;

/**
 * Sends a consent confirmation. These NEVER quote (CCB-S3-003): a `/publish` is
 * one word, so repeating it above the answer adds nothing but clutter — the same
 * clutter this briefing removes from the natural-language path. In `mention` mode
 * the member's name is prefixed instead, which is what ties the notice to them.
 *
 * The chat rendering was never the consent record: `consent` and `consent_actions`
 * are. Do not reintroduce the quote to "prove" who opted in.
 */
async function reply(
  botHandle: BotHandle,
  msg: CapturedMessage,
  text: string,
  s: InteractionSettings,
  send: ConsentSender | undefined,
): Promise<void> {
  try {
    const out = formatOutbound(text, {
      mode: s.replyMode,
      prefixTemplate: s.namePrefix.enabled
        ? (s.namePrefix.templates[s.defaultLanguage] ?? s.namePrefix.templates['en'] ?? null)
        : null,
      displayName: msg.senderDisplayName,
      allowQuote: false,
    });
    // A consent confirmation is archive content of the "consent" category
    // (CCB-S3-007 §3). It names the member only when the prefix put their name
    // there — and note that an /unpublish confirmation therefore names somebody
    // who has, one line earlier, just opted OUT: the guard redacts it, which is
    // the correct answer and worth keeping in mind before "simplifying" it.
    const meta = {
      quote: out.quote,
      category: 'consent' as const,
      lang: s.defaultLanguage,
      mentions: out.prefixName
        ? [{ displayName: out.prefixName, memberId: msg.senderMemberId }]
        : [],
    };
    if (send) {
      await send(msg, out.text, meta);
    } else {
      await sendToChat(botHandle.chat, msg, out.text, { quote: out.quote });
    }
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
  interaction?: { get(): InteractionSettings },
  /** Called after a confirmation is sent, so the follow-up window opens (§7c). */
  onReplied?: (groupId: number, memberId: string) => void,
  /**
   * The archiving transport (CCB-S3-007). Optional so the harnesses and the
   * connect script can still build a handler with nothing behind it; when it is
   * absent the confirmation is sent exactly as before and simply not archived.
   */
  opts?: { send?: ConsentSender },
): (msg: CapturedMessage, command: ConsentCommand) => Promise<void> {
  return async (msg, command) => {
    const db = getPool();
    // Read the presentation settings ONCE, up front, and never between recording
    // a consent change and confirming it: a throw in that gap would send the
    // failure notice for a decision that was actually written.
    let presentation = DEFAULT_INTERACTION;
    try {
      presentation = interaction?.get() ?? DEFAULT_INTERACTION;
    } catch (err) {
      log.warn(
        `Could not read interaction settings for a consent confirmation; using defaults (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
    }
    try {
      // Slash commands stay IMMEDIATE (CCB-S3-002 §4.1) — the confirmation
      // handshake applies to natural language only. They share the write path
      // with it so both are journalled and undoable in the same way.
      if (command === 'publish') {
        await applyConsentChange(db, {
          memberId: msg.senderMemberId,
          at: msg.sentAt,
          action: 'opt_in',
          source: 'slash',
        });
        log.info(`Consent: opt-in recorded for member ${msg.senderMemberId}.`);
        await reply(botHandle, msg, PUBLISH_REPLY, presentation, opts?.send);
        onReplied?.(msg.groupId, msg.senderMemberId);
      } else {
        const { hadActive } = await applyConsentChange(db, {
          memberId: msg.senderMemberId,
          at: msg.sentAt,
          action: 'opt_out',
          source: 'slash',
        });
        log.info(
          `Consent: opt-out recorded for member ${msg.senderMemberId} (had active consent: ${hadActive}).`,
        );
        await reply(botHandle, msg, UNPUBLISH_REPLY, presentation, opts?.send);
        onReplied?.(msg.groupId, msg.senderMemberId);
      }
    } catch (err) {
      // Fail loudly toward the member and the operator — never silently drop a
      // consent decision (it is the product's legal backbone).
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Consent command /${command} failed for member ${msg.senderMemberId}: ${message}`);
      status.error(
        `Consent command /${command} failed for member ${msg.senderMemberId}: ${message}`,
      );
      await reply(botHandle, msg, FAILURE_REPLY, presentation, opts?.send);
    }
  };
}
