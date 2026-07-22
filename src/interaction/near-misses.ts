/**
 * Near-miss diagnostics (CCB-S3-005 §5).
 *
 * Every guard that makes Cinderella stay silent also makes her invisible: a bot
 * that correctly ignores a message and a bot that is broken look identical from
 * the outside. That is precisely how the false positive this briefing fixes went
 * unnoticed until it fired in public. So each ignored candidate is recorded with
 * the reason, and the admin console shows them.
 *
 * A module-level buffer rather than engine state, because the admin server is
 * constructed before the capture worker and there is exactly one of each per
 * process. Threading the engine into the web context to read a debug list would
 * be more plumbing for no benefit.
 *
 * IN MEMORY ONLY, capped, and truncated. These are messages that were
 * deliberately NOT treated as instructions, and several were never archived
 * either — they are diagnostics, not a record, and they do not survive a
 * restart. That matches the same doctrine as the rest of the conversation state.
 */

/** Why a message that looked like an address was ignored. */
export type NearMissReason =
  'forwarded' | 'weak-signal-unknown' | 'too-long' | 'strict-mode-no-greeting';

export interface NearMiss {
  /** Epoch ms. */
  at: number;
  groupId: number;
  /** Display name — easier for an operator to act on than a member id. */
  who: string;
  reason: NearMissReason;
  /** Truncated text, enough to recognise the message and no more. */
  excerpt: string;
  /** The resolver's verdict, where one was reached. */
  intent: string | undefined;
  confidence: number | undefined;
}

/** How many to keep. Diagnostics, not history. */
const LIMIT = 50;

/** How much of the offending text to keep. */
export const NEAR_MISS_EXCERPT = 140;

/** Operator-facing explanation of each reason, shown in the console. */
export const NEAR_MISS_REASONS: Record<NearMissReason, string> = {
  forwarded: 'Forwarded message — shared content, not someone speaking to her',
  'weak-signal-unknown': 'Not understood, and the address signal was weak (bare name)',
  'too-long': 'Too long to be a command, and no high-confidence intent',
  'strict-mode-no-greeting': 'Strict mode — a bare leading name needs a greeting',
};

const buffer: NearMiss[] = [];

export function recordNearMiss(entry: NearMiss): void {
  buffer.unshift(entry);
  if (buffer.length > LIMIT) buffer.length = LIMIT;
}

/** Most recent first. */
export function recentNearMisses(limit = LIMIT): NearMiss[] {
  return buffer.slice(0, limit);
}

/** Test hook — the harness asserts on a clean buffer. */
export function clearNearMisses(): void {
  buffer.length = 0;
}
