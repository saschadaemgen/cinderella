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
  /** Attached media/file, if any. */
  file: CapturedFile | undefined;
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

/**
 * Parses an incoming chat item into a CapturedMessage, or returns `null` if it
 * is not a capturable group message.
 *
 * Only *received group messages* are captured:
 *   - group chats (not direct/local),
 *   - the `groupRcv` direction (a real member's message — never the bot's own
 *     sends, and never system events like "member joined"),
 *   - actual message content (`rcvMsgContent`), not group-event content.
 */
export function parseGroupMessage(aChatItem: T.AChatItem): CapturedMessage | null {
  const { chatInfo, chatItem } = aChatItem;

  if (chatInfo.type !== 'group') return null;
  const groupInfo = chatInfo.groupInfo;

  const dir = chatItem.chatDir;
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
    file,
    raw: aChatItem,
  };
}
