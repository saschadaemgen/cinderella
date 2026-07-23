/**
 * Normalizes a raw SimpleX `AChatItem` into a `CapturedMessage` — the shape
 * Cinderella works with across every stage (log in Stage 1, persist in Stage 2,
 * consent-gate in Stage 3).
 *
 * All SimpleX types are discriminated unions keyed on a `type` string, so this
 * module reads those discriminants directly and never depends on runtime enums.
 */

import type { T } from '@simplex-chat/types';

/** The capture type taxonomy from the briefing (§5 Stage 2). */
export type CapturedType = 'text' | 'image' | 'video' | 'voice' | 'link' | 'file';

export interface CapturedFile {
  /** SimpleX file id — used to issue the receive-file command. */
  fileId: number;
  fileName: string;
  fileSize: number;
  /**
   * Path the SimpleX core wrote the file to once received (relative to the
   * files folder, or absolute). Undefined until the file transfer completes.
   */
  sourcePath: string | undefined;
}

export interface LinkPreview {
  url: string;
  title: string | undefined;
  description: string | undefined;
  /**
   * The base64 thumbnail the sender's client generated (CCB-S3-014). Kept so we
   * can serve it locally instead of fetching from a third party — see
   * media/thumbnail.ts. Undefined when the client sent no image.
   */
  image: string | undefined;
}

export interface CapturedMessage {
  /** Local numeric group id (SimpleX DB). */
  groupId: number;
  /** Group's local display name. */
  groupName: string;
  /**
   * Chat-item id (SimpleX DB). Stable within the bot's SimpleX DB and the id
   * that in-group deletion events (`groupChatItemsDeleted.chatItemIDs`) refer
   * to — so this is what we persist as `group_msg_id`.
   */
  itemId: number;
  /** Shared message id (base64) — stable across members; useful for tracing. */
  sharedMsgId: string | undefined;
  /** Stable group member id (NOT the display name — see briefing §9). */
  senderMemberId: string;
  /** Sender's current display name (may collide across members). */
  senderDisplayName: string;
  /** Group-message timestamp (ISO 8601). */
  sentAt: string;
  /** Capture type classification. */
  type: CapturedType;
  /** Text body (may be empty for pure-media messages). */
  text: string;
  /** Link preview, present only for `link`-type messages. */
  linkPreview: LinkPreview | undefined;
  /** Attached media/file, if any. */
  file: CapturedFile | undefined;
  /**
   * True when the member FORWARDED this message rather than writing it.
   *
   * This is `meta.itemForwarded` (the field the clients use to draw the
   * "forwarded" label), NOT `meta.forwardedByMember`. They are different things
   * and confusing them breaks consent: `forwardedByMember` is a group ROUTING
   * detail and is set on ordinary messages — verified in the live SimpleX DB,
   * where real `/publish` commands carry it. Keying the guard off that field
   * would silently stop `/publish` from working.
   */
  forwarded: boolean;
  /**
   * True when this message is a direct reply to one of the BOT's own messages.
   * That is an address in itself (CCB-S3-002 §1.2) — replying to her needs no
   * wake word. `groupSnd` on the quoted item means "sent by us in this group".
   */
  quotedFromBot: boolean;
  /** The raw AChatItem, for the `raw_json` column and debugging. */
  raw: T.AChatItem;
}

function classifyType(msgContent: T.MsgContent, hasFile: boolean): CapturedType {
  switch (msgContent.type) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'voice':
      return 'voice';
    case 'file':
      return 'file';
    case 'link':
    case 'chat':
      // `chat` carries a SimpleX chat link; treat like a link message.
      return 'link';
    case 'text':
    case 'report':
    case 'unknown':
    default:
      return hasFile ? 'file' : 'text';
  }
}

function buildCapturedFile(file: T.CIFile | undefined): CapturedFile | undefined {
  if (!file) return undefined;
  return {
    fileId: file.fileId,
    fileName: file.fileName,
    fileSize: file.fileSize,
    sourcePath: file.fileSource?.filePath,
  };
}

function buildLinkPreview(msgContent: T.MsgContent): LinkPreview | undefined {
  if (msgContent.type !== 'link') return undefined;
  const { preview } = msgContent;
  return {
    url: preview.uri,
    title: preview.title || undefined,
    description: preview.description || undefined,
    image: preview.image || undefined,
  };
}

/**
 * SECURITY GATE (CCB-S3-019): is this incoming chat item a PUBLIC group message —
 * the only thing Cinderella is ever allowed to capture?
 *
 * A group chat item can arrive on a private per-member SUPPORT scope (the member's
 * "Chat with admins" thread), delivered on the very same `newChatItems` event as
 * ordinary group messages (CCB-S3-016 §8a). Capturing one would publish a private
 * conversation to the public archive — the one thing a private channel exists to
 * prevent, and unrecoverable once read. The reliable discriminator is
 * `ChatInfo.Group.groupChatScope`: absent on a public group message, present (a
 * `memberSupport` scope) on the private thread (types.d.ts:978).
 *
 * The durable rule — which also satisfies CCB-S3-017 §2's direct-chat exclusion —
 * is a WHITELIST, not a blacklist: capture only when the item is POSITIVELY a
 * plain public group chat. Direct/local/contact chats are not `group`; a scoped
 * group item carries `groupChatScope`. Anything else, or anything ambiguous, is
 * out. Fail CLOSED: a missing archive row is recoverable; a leaked private message
 * is not. A future message type or scope that this predicate does not recognise as
 * public is therefore excluded by construction, not by being added to a list.
 */
export function isPublicGroupChat(chatInfo: T.ChatInfo): chatInfo is T.ChatInfo.Group {
  return chatInfo.type === 'group' && chatInfo.groupChatScope === undefined;
}

/**
 * Parses an incoming chat item into a CapturedMessage, or returns `null` if it
 * is not a capturable group message.
 *
 * Only *received PUBLIC group messages* are captured:
 *   - public group chats — NOT direct/local, and NOT a member-support scope
 *     (CCB-S3-019); {@link isPublicGroupChat} is the single gate every incoming
 *     item passes through (also used by the in-group deletion handler),
 *   - the `groupRcv` direction (a real member's message — never the bot's own
 *     sends, and never system events like "member joined"),
 *   - actual message content (`rcvMsgContent`), not group-event content.
 */
export function parseGroupMessage(aChatItem: T.AChatItem): CapturedMessage | null {
  const { chatInfo, chatItem } = aChatItem;

  // CCB-S3-019: the private-scope gate, before persistence, consent, or anything.
  if (!isPublicGroupChat(chatInfo)) return null;
  const groupInfo = chatInfo.groupInfo;

  const dir = chatItem.chatDir;
  // Her OWN sends (`groupSnd`) are archived by the send site instead
  // (capture/bot-message.ts), and must never come back through here: this
  // function feeds the consent-command parser and the dialogue engine, so a
  // reply of hers arriving as input would let her answer herself. The
  // `groupRcv` test below already excludes them — this note is here so a future
  // widening of it is a decision rather than an accident.
  if (dir.type !== 'groupRcv') return null;
  const member = dir.groupMember;

  const content = chatItem.content;
  if (content.type !== 'rcvMsgContent') return null;
  const msgContent = content.msgContent;

  const file = buildCapturedFile(chatItem.file);

  return {
    groupId: groupInfo.groupId,
    groupName: groupInfo.localDisplayName,
    itemId: chatItem.meta.itemId,
    sharedMsgId: chatItem.meta.itemSharedMsgId,
    senderMemberId: member.memberId,
    senderDisplayName: member.memberProfile.displayName || member.localDisplayName,
    sentAt: chatItem.meta.itemTs,
    type: classifyType(msgContent, file !== undefined),
    text: msgContent.text ?? '',
    linkPreview: buildLinkPreview(msgContent),
    file,
    forwarded: chatItem.meta.itemForwarded !== undefined,
    quotedFromBot: chatItem.quotedItem?.chatDir?.type === 'groupSnd',
    raw: aChatItem,
  };
}
