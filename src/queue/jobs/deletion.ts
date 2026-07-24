/**
 * Durable in-group deletion (CCB-S3-023 follow-up).
 *
 * When a member deletes a message in the group, it must leave the public archive.
 * That is done by `markDeleted` (group_deleted = TRUE), which the publish views
 * honour. The problem this job solves: the SimpleX deletion event is delivered
 * ONCE and never re-sent, so if that single `markDeleted` write fails transiently
 * (a deadlock, a connection blip), the deletion was lost forever and the content
 * stayed published, silently. That is a consent breach, not a display bug.
 *
 * So a failed deletion is enqueued here and retried by the durable queue until it
 * succeeds, or dead-letters where the operator can see it. The handler is
 * idempotent: `markDeleted` setting group_deleted = TRUE again is a no-op, so a
 * repeat run (crash, restart, manual retry) is harmless. An unusable payload fails
 * fast rather than retrying forever.
 */

import { getPool } from '../../db/pool.js';
import { markDeleted } from '../../db/messages.js';
import { log } from '../../log.js';
import { PermanentJobError, type JobHandler } from '../types.js';

/** The stable job type. */
export const DELETION_APPLY_JOB = 'deletion.apply';

/** Idempotency key for one (group, message-set) deletion — order-independent. */
export function deletionApplyKey(groupId: number, groupMsgIds: readonly number[]): string {
  return `deletion.apply:${groupId}:${[...groupMsgIds].sort((a, b) => a - b).join(',')}`;
}

export const deletionApplyHandler: JobHandler = async (payload) => {
  const groupId = Number(payload['groupId']);
  const raw = payload['groupMsgIds'];
  const ids = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isFinite(n)) : [];
  if (!Number.isFinite(groupId) || ids.length === 0) {
    // A payload that can never become valid: dead-letter immediately, do not spin.
    throw new PermanentJobError(
      `deletion.apply: invalid payload (group ${String(payload['groupId'])}, ids ${JSON.stringify(raw)}).`,
    );
  }
  const n = await markDeleted(getPool(), groupId, ids);
  log.info(
    `Queue: applied in-group deletion for group ${groupId}, message(s) ${ids.join(', ')} ` +
      `(${n} row(s) marked deleted).`,
  );
};
