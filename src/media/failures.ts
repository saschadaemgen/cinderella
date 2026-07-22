/**
 * Media serving failures, made visible (CCB-S3-011 Addendum A).
 *
 * The fail-closed gate is right: an image whose metadata could not be stripped
 * must not be served. But "not served" and "nothing is wrong" look identical from
 * the outside, and that is exactly how this went unnoticed — the derivative
 * directory was created by a one-off script running as root, the service user
 * could not write into it, and every new photograph silently 404'd. The operator
 * saw an empty stream; nothing said why.
 *
 * So a withheld image is recorded and surfaced, like the near-miss log and the
 * provider-health table. An empty stream must never be the first indication that
 * something broke.
 *
 * In memory only, capped. Diagnostics, not history.
 */

export type MediaFailureReason =
  /** A strippable format whose derivative is missing and could not be made. */
  | 'no-derivative'
  /** The derivative is recorded but not readable on disk. */
  | 'derivative-unreadable'
  /** Stripping itself failed — decode error, or no permission to write. */
  | 'strip-failed';

export interface MediaFailure {
  at: number;
  messageId: number;
  reason: MediaFailureReason;
  /** Short cause, safe to display. Never a member filename. */
  detail: string;
}

const LIMIT = 50;
const buffer: MediaFailure[] = [];

export function recordMediaFailure(f: Omit<MediaFailure, 'at'>): void {
  // Collapse repeats: one broken image requested a hundred times is one fault,
  // and a hundred identical rows would push every other fault out of the buffer.
  const existing = buffer.findIndex((x) => x.messageId === f.messageId && x.reason === f.reason);
  if (existing >= 0) buffer.splice(existing, 1);
  buffer.push({ ...f, at: Date.now() });
  if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);
}

/** Newest first. */
export function recentMediaFailures(limit = LIMIT): MediaFailure[] {
  return buffer.slice(-limit).reverse();
}

export function clearMediaFailures(): void {
  buffer.length = 0;
}
