/**
 * Unrecognised capture-scope diagnostics (CCB-S3-019 follow-up).
 *
 * The capture gate (`isPublicGroupChat`) is a whitelist: only a public group
 * message is archived. MOST exclusions are expected and silent — a direct/local
 * chat, or a member's private support ("Chat with admins") scope. Those are the
 * guard working as designed and are not recorded; surfacing them would only bury
 * the signal that matters.
 *
 * But if a GROUP item arrives with a scope we do NOT recognise — a new SDK scope,
 * a malformed item, or a wrong assumption on our side — capture is silently
 * stopping for a reason we do not understand, and dropping messages with no trace
 * is exactly the failure mode this project keeps closing. So the unrecognised case
 * (and only that case) is counted and surfaced in the admin dashboard.
 *
 * In memory only, capped, per process (the admin server is built before the
 * capture worker, and there is one of each) — diagnostics, not history. A total
 * counter is kept alongside the ring buffer so the count stays honest even if a
 * flood truncates the buffer.
 */

export interface UnknownScope {
  /** Epoch ms. */
  at: number;
  /** The unrecognised scope discriminator, or '(malformed)' when it had none. */
  scopeType: string;
  /** Group the item came from, when known. */
  groupId: number | null;
}

/** How many to keep. Diagnostics, not history. */
const LIMIT = 50;

const buffer: UnknownScope[] = [];
let total = 0;

export function recordUnknownScope(entry: Omit<UnknownScope, 'at'>): void {
  buffer.unshift({ at: Date.now(), ...entry });
  if (buffer.length > LIMIT) buffer.length = LIMIT;
  total++;
}

/** Most recent first. */
export function recentUnknownScopes(limit = LIMIT): UnknownScope[] {
  return buffer.slice(0, limit);
}

/** Total ever seen this process — honest even after buffer truncation. */
export function unknownScopeCount(): number {
  return total;
}

/** Test hook — the harness asserts on a clean counter. */
export function clearUnknownScopes(): void {
  buffer.length = 0;
  total = 0;
}
