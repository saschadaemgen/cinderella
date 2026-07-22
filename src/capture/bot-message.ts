/**
 * Capturing Cinderella's own messages (CCB-S3-007).
 *
 * Her replies are recorded at the SEND SITE rather than from the `newChatItems`
 * stream, for one reason: only the send site knows what kind of reply it was. The
 * event carries text and an item id, and matching a category back onto it would
 * mean guessing from the text — which is exactly the sort of inference that turns
 * a nickname retort into an archived "consent confirmation" the day somebody
 * edits a persona string. The handler that produces a reply declares its category,
 * and it travels with the message.
 *
 * The member-capture path cannot pick these up as a second copy: `parseGroupMessage`
 * only accepts `groupRcv` items, and hers are `groupSnd`.
 *
 * A failure here is logged and swallowed. Archiving her side is a presentation
 * improvement; a member's reply must never fail to send, or a consent
 * confirmation to arrive, because a bookkeeping insert went wrong.
 */

import type { T } from '@simplex-chat/types';
import { log } from '../log.js';
import { withTransaction, type Queryable } from '../db/pool.js';
import { insertBotMessage, resolveMemberByDisplayName, type BotMention } from '../db/bot-messages.js';
import { redactNames } from '../archive/redact.js';
import { messageIdFor } from '../media/pipeline.js';
import type { ReplyCategory } from '../archive/settings.js';

/** A member named in a reply, as the send site knows them. */
export interface ReplyMention {
  /** Exactly the text embedded in the message, after display-name sanitising. */
  displayName: string;
  /**
   * The member id, when the send site already knows it — the name prefix names
   * the SENDER, whose id is right there. Supplying it matters: resolving that
   * same name by lookup returns nothing when two members share a display name,
   * which would redact a member who had actually consented.
   *
   * Omitted when the name came from a member's own typing (a third-party
   * refusal), in which case it is looked up, and an ambiguous or unknown name
   * stays unresolved — and therefore unpublishable.
   */
  memberId?: string;
}

/** What a reply declares about itself as it goes out. */
export interface BotReplyMeta {
  /**
   * The kind of reply. Null means a send site nobody classified — it is stored
   * (the operator can see it) but never published.
   */
  category: ReplyCategory | null;
  /** The language she answered in. */
  lang: string;
  /** Members named in the text. */
  mentions?: readonly ReplyMention[];
  /**
   * The member message this reply answers (CCB-S3-009), as (group, item). It is
   * resolved to a row id at record time so the pair is one object: the
   * derivation withholds an answer whose question is not published, and deleting
   * the question takes the answer with it.
   */
  replyTo?: { groupId: number; itemId: number };
}

/** The one field of a sent group item we need beyond ids. */
interface SentGroupItem {
  groupId: number;
  itemId: number;
  sharedMsgId: string | null;
  sentAt: string;
  /** The bot's own stable member id in that group. */
  memberId: string;
  displayName: string;
}

/**
 * Narrows a sent chat item to the group send we archive. Anything else — a direct
 * message, a received item, a group event — is not hers to archive here.
 */
function parseSentGroupItem(aChatItem: T.AChatItem): SentGroupItem | null {
  const { chatInfo, chatItem } = aChatItem;
  if (chatInfo.type !== 'group') return null;
  if (chatItem.chatDir.type !== 'groupSnd') return null;
  const me = chatInfo.groupInfo.membership;
  if (!me?.memberId) return null;
  return {
    groupId: chatInfo.groupInfo.groupId,
    itemId: chatItem.meta.itemId,
    sharedMsgId: chatItem.meta.itemSharedMsgId ?? null,
    sentAt: chatItem.meta.itemTs,
    memberId: me.memberId,
    displayName: me.memberProfile?.displayName || me.localDisplayName || 'Cinderella',
  };
}

/**
 * Records the messages a send produced.
 *
 * When the operator has switched her publication off entirely, or excluded this
 * category, the row is still WRITTEN — publication is derived, so the operator can
 * turn a category back on and her older replies appear, exactly as flipping it off
 * makes them disappear. Storing only what is currently publishable would have made
 * the setting a one-way door.
 */
export async function recordBotReply(
  db: Queryable,
  sent: readonly T.AChatItem[],
  text: string,
  meta: BotReplyMeta,
  redactedPlaceholder: string,
): Promise<void> {
  const seen = new Set<string>();
  const wanted = (meta.mentions ?? []).filter((m) => {
    const name = m.displayName.trim();
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  const mentions: BotMention[] = [];
  for (const m of wanted) {
    let memberId: string | null = m.memberId ?? null;
    if (!memberId) {
      try {
        memberId = await resolveMemberByDisplayName(db, m.displayName);
      } catch (err) {
        // An unresolved name is the SAFE outcome (it is treated as
        // non-consenting), so a lookup failure needs nothing beyond a note.
        log.debug(
          `Bot capture: could not resolve "${m.displayName}" to a member: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    mentions.push({ memberId, displayName: m.displayName });
  }

  // Search must not be able to find a member through her words, whether or not
  // that member consented — see archive/redact.ts. Always a string for a bot row:
  // the column is the ONLY thing her rows are indexed by, and a null there would
  // be a row nobody can find (the CHECK constraint in migration 013 enforces it).
  const names = mentions.map((m) => m.displayName);
  const searchBody = names.length > 0 ? redactNames(text, names, redactedPlaceholder) : text;

  const replyToId = meta.replyTo
    ? await messageIdFor(db, meta.replyTo.groupId, meta.replyTo.itemId)
    : null;

  for (const item of sent) {
    const parsed = parseSentGroupItem(item);
    if (!parsed) continue;
    await insertBotMessage(db, {
      replyToId,
      groupId: parsed.groupId,
      groupMsgId: parsed.itemId,
      sharedMsgId: parsed.sharedMsgId,
      senderMemberId: parsed.memberId,
      senderDisplayName: parsed.displayName,
      sentAt: parsed.sentAt,
      text,
      category: meta.category,
      lang: meta.lang,
      searchBody,
      mentions,
      rawJson: item,
    });
  }
}

/**
 * Wraps a send so that whatever it sends is also archived. Errors from the
 * recording half never reach the caller — see the file header.
 */
export function withBotCapture(
  placeholder: (lang: string) => string,
  send: (text: string, opts: { quote: boolean }) => Promise<readonly T.AChatItem[]>,
): (text: string, opts: { quote: boolean } & BotReplyMeta) => Promise<void> {
  return async (text, opts) => {
    // The send comes first and is NOT in the try: a message that failed to go out
    // must not be archived as though it had.
    const sent = await send(text, { quote: opts.quote });
    try {
      // One transaction, so the message and the names it contains are written
      // together or not at all — see insertBotMessage.
      await withTransaction((tx) => recordBotReply(tx, sent, text, opts, placeholder(opts.lang)));
    } catch (err) {
      log.warn(
        `Could not archive Cinderella's own message: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}
