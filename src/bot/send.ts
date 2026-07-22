/**
 * The single outbound transport for Cinderella's chat replies (CCB-S3-003).
 *
 * Two SDK calls produce visibly different messages, and both the natural-language
 * engine and the slash-command handler need to choose between them. Routing both
 * through here means the choice cannot drift between the two paths — which was
 * the actual bug: the interaction layer and the consent commands each called
 * `apiSendTextReply` independently, so every single reply quoted.
 */

import type { api } from 'simplex-chat';
import type { T } from '@simplex-chat/types';
import { log } from '../log.js';
import type { CapturedMessage } from '../capture/message.js';

export interface SendOptions {
  /** Quote the triggering message above the answer. */
  quote: boolean;
}

/**
 * Sends `text` into the chat `msg` came from, and returns the chat items the core
 * created for it (CCB-S3-007 — her own messages are archived, and the item id is
 * how one is identified).
 *
 * `apiSendTextMessage` with no `inReplyTo` is the plain form: a normal group
 * message. `msg.raw.chatInfo` is exactly the `ChatInfo` that overload accepts, so
 * no group lookup is needed.
 *
 * If the chat reference is somehow missing we fall back to the quoting form
 * rather than dropping the message: a cluttered reply is a cosmetic problem, a
 * silently unsent consent confirmation is not.
 */
export async function sendToChat(
  chat: api.ChatApi,
  msg: CapturedMessage,
  text: string,
  opts: SendOptions,
): Promise<T.AChatItem[]> {
  if (!opts.quote) {
    const chatInfo = msg.raw.chatInfo;
    if (chatInfo) {
      return await chat.apiSendTextMessage(chatInfo, text);
    }
    log.warn(
      `Outbound reply for item ${msg.itemId} has no chat reference; falling back to a quoting reply.`,
    );
  }
  return await chat.apiSendTextReply(msg.raw, text);
}
