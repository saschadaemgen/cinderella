/**
 * Conversation state for the interaction layer (CCB-S3-002 §2, §4.5, §6).
 *
 * Deliberately in-process and deliberately forgetful. Everything here is
 * short-lived UI state — who she is mid-sentence with, which retort she used
 * last, how much she has said recently — and none of it is a consent record.
 * Consent lives in PostgreSQL; losing this map across a restart costs a member
 * one repeated wake word, which is the correct trade for not persisting a
 * conversational side-channel about who spoke to the bot and when.
 *
 * Three mechanisms live here:
 *
 *  - the **follow-up window** (§2), which is what turns commands into
 *    conversation: after she replies, that member may keep talking without
 *    repeating her name;
 *  - the **reply rate limit** (§4.5), per member and per chat, so the group
 *    cannot be flooded through her;
 *  - the **retort rotation and anti-spam counter** (§6), so she never repeats a
 *    nickname retort back-to-back in a chat and goes quiet if someone is just
 *    poking her.
 */

import type { Intent } from './intent.js';

/** A consent change she has proposed and is waiting to hear `yes` about. */
export interface PendingConfirmation {
  intent: Extract<Intent, 'PUBLISH' | 'UNPUBLISH'>;
  /** Language the request came in — the answer follows it. */
  lang: string;
  /** Epoch ms after which the offer lapses (tracks the follow-up window). */
  expiresAt: number;
}

interface MemberEntry {
  followUpUntil: number;
  /** Language detected for this member, kept for the follow-up window (§6). */
  lang: string | undefined;
  pending: PendingConfirmation | undefined;
  /** Consecutive nickname addresses; resets on a proper address or after a rest. */
  nicknameStreak: number;
  lastNicknameAt: number;
  /** Epoch ms of recent replies to this member (for the per-member limit). */
  replies: number[];
}

interface ChatEntry {
  /** Index of the last retort used here, so the next one differs. */
  lastRetort: number;
  replies: number[];
}

/** A nickname streak this old is forgiven — she is petty, not unforgiving. */
const NICKNAME_STREAK_RESET_MS = 10 * 60 * 1000;

/** Window the reply rate limits are measured over. */
const RATE_WINDOW_MS = 60 * 1000;

/** Entries untouched for this long are dropped by {@link ConversationState.prune}. */
const IDLE_EVICT_MS = 60 * 60 * 1000;

function trim(times: number[], now: number): number[] {
  const cutoff = now - RATE_WINDOW_MS;
  return times.filter((t) => t > cutoff);
}

export class ConversationState {
  private readonly members = new Map<string, MemberEntry>();
  private readonly chats = new Map<number, ChatEntry>();
  private lastPruneAt = 0;

  private static key(groupId: number, memberId: string): string {
    return `${groupId}:${memberId}`;
  }

  private member(groupId: number, memberId: string): MemberEntry {
    const key = ConversationState.key(groupId, memberId);
    let entry = this.members.get(key);
    if (!entry) {
      entry = {
        followUpUntil: 0,
        lang: undefined,
        pending: undefined,
        nicknameStreak: 0,
        lastNicknameAt: 0,
        replies: [],
      };
      this.members.set(key, entry);
    }
    return entry;
  }

  private chat(groupId: number): ChatEntry {
    let entry = this.chats.get(groupId);
    if (!entry) {
      entry = { lastRetort: -1, replies: [] };
      this.chats.set(groupId, entry);
    }
    return entry;
  }

  /* ── Follow-up window (§2) ─────────────────────────────────────────────── */

  /** Is this member mid-conversation with her in this chat? */
  inFollowUp(groupId: number, memberId: string, now: number): boolean {
    const key = ConversationState.key(groupId, memberId);
    const entry = this.members.get(key);
    return entry !== undefined && entry.followUpUntil > now;
  }

  /** Opens or refreshes the window. Called whenever she replies to a member. */
  openFollowUp(groupId: number, memberId: string, now: number, windowMs: number): void {
    if (windowMs <= 0) return;
    this.member(groupId, memberId).followUpUntil = now + windowMs;
  }

  /**
   * Remembers the language an exchange is being held in (§6), so a bare `yes`
   * that carries no linguistic signal of its own is answered in the language of
   * the conversation it belongs to rather than the instance default.
   */
  rememberLanguage(groupId: number, memberId: string, lang: string): void {
    this.member(groupId, memberId).lang = lang;
  }

  /** The remembered language, but only while the follow-up window is still open. */
  rememberedLanguage(groupId: number, memberId: string, now: number): string | undefined {
    const entry = this.members.get(ConversationState.key(groupId, memberId));
    if (!entry || entry.followUpUntil <= now) return undefined;
    return entry.lang;
  }

  closeFollowUp(groupId: number, memberId: string): void {
    const entry = this.members.get(ConversationState.key(groupId, memberId));
    if (entry) entry.followUpUntil = 0;
  }

  /* ── Pending consent confirmations (§4.1) ──────────────────────────────── */

  getPending(groupId: number, memberId: string, now: number): PendingConfirmation | undefined {
    const entry = this.members.get(ConversationState.key(groupId, memberId));
    if (!entry?.pending) return undefined;
    if (entry.pending.expiresAt <= now) {
      entry.pending = undefined;
      return undefined;
    }
    return entry.pending;
  }

  setPending(groupId: number, memberId: string, pending: PendingConfirmation): void {
    this.member(groupId, memberId).pending = pending;
  }

  clearPending(groupId: number, memberId: string): void {
    const entry = this.members.get(ConversationState.key(groupId, memberId));
    if (entry) entry.pending = undefined;
  }

  /* ── Nicknames (§6) ────────────────────────────────────────────────────── */

  /**
   * Records a nickname address and reports whether she should answer. After
   * `spamLimit` in a row she stays silent rather than feeding the game.
   */
  noteNickname(groupId: number, memberId: string, now: number, spamLimit: number): boolean {
    const entry = this.member(groupId, memberId);
    if (now - entry.lastNicknameAt > NICKNAME_STREAK_RESET_MS) entry.nicknameStreak = 0;
    entry.lastNicknameAt = now;
    entry.nicknameStreak += 1;
    return entry.nicknameStreak <= spamLimit;
  }

  /** Called when the member gets her name right — the slate is wiped. */
  resetNicknameStreak(groupId: number, memberId: string): void {
    const entry = this.members.get(ConversationState.key(groupId, memberId));
    if (entry) entry.nicknameStreak = 0;
  }

  nicknameStreak(groupId: number, memberId: string): number {
    return this.members.get(ConversationState.key(groupId, memberId))?.nicknameStreak ?? 0;
  }

  /**
   * Picks a retort index for this chat, never repeating the previous one.
   * `random` is injected so the harness can assert the no-repeat property
   * without depending on luck.
   */
  pickRetort(groupId: number, count: number, random: () => number): number {
    if (count <= 0) return -1;
    const entry = this.chat(groupId);
    if (count === 1) {
      entry.lastRetort = 0;
      return 0;
    }
    // Draw from the count-1 indices that are not the previous one, then shift
    // past it — a uniform pick with the repeat structurally excluded.
    const draw = Math.min(count - 2, Math.floor(random() * (count - 1)));
    const index = entry.lastRetort >= 0 && draw >= entry.lastRetort ? draw + 1 : draw;
    entry.lastRetort = index;
    return index;
  }

  /* ── Reply rate limits (§4.5) ──────────────────────────────────────────── */

  /**
   * Consumes one reply allowance. Returns false when either the member's or the
   * chat's budget for the last minute is spent, in which case she stays silent.
   */
  allowReply(
    groupId: number,
    memberId: string,
    now: number,
    perMember: number,
    perChat: number,
  ): boolean {
    const m = this.member(groupId, memberId);
    const c = this.chat(groupId);
    m.replies = trim(m.replies, now);
    c.replies = trim(c.replies, now);
    if (m.replies.length >= perMember || c.replies.length >= perChat) return false;
    m.replies.push(now);
    c.replies.push(now);
    return true;
  }

  /** Records a reply that bypassed the limiter, so it still counts toward it. */
  noteReply(groupId: number, memberId: string, now: number): void {
    const m = this.member(groupId, memberId);
    const c = this.chat(groupId);
    m.replies = trim(m.replies, now);
    c.replies = trim(c.replies, now);
    m.replies.push(now);
    c.replies.push(now);
  }

  /* ── Housekeeping ──────────────────────────────────────────────────────── */

  /** Drops entries nobody has touched for an hour. Cheap; called opportunistically. */
  prune(now: number): void {
    if (now - this.lastPruneAt < 5 * 60 * 1000) return;
    this.lastPruneAt = now;
    for (const [key, entry] of this.members) {
      const lastActivity = Math.max(
        entry.followUpUntil,
        entry.lastNicknameAt,
        entry.pending?.expiresAt ?? 0,
        entry.replies[entry.replies.length - 1] ?? 0,
      );
      if (now - lastActivity > IDLE_EVICT_MS) this.members.delete(key);
    }
    for (const [id, entry] of this.chats) {
      const lastActivity = entry.replies[entry.replies.length - 1] ?? 0;
      if (now - lastActivity > IDLE_EVICT_MS) this.chats.delete(id);
    }
  }
}
