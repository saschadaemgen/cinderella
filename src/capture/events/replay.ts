/**
 * Capture write-ahead log — the replay engine (CCB-S3-024).
 *
 * The store (store.ts) records raw events; this module applies them. The same
 * `processEvent` is used by the real-time capture path (record, then process) and
 * by the drain (retry whatever is still pending), so an event takes exactly one
 * code path whether it is applied on arrival or minutes later after a DB blip.
 *
 * How an event is applied is NOT decided here — the dispatcher registers a
 * reprocessor per kind (registerCaptureReprocessor), keeping this module free of
 * the SimpleX SDK and the persist layer. A reprocessor returns 'applied' when the
 * event took effect, 'deferred' when it cannot yet (its target message has not
 * arrived), and throws for a transient failure (retried) or a PermanentJobError
 * (dead-lettered at once).
 */

import type { Queryable } from '../../db/pool.js';
import { getPool } from '../../db/pool.js';
import { log } from '../../log.js';
import { isPermanent, type JobHandler } from '../../queue/types.js';
import {
  deadLetterEvent,
  deferEvent,
  failEvent,
  markEventProcessed,
  nextDrainBatch,
  type CaptureEventKind,
  type CaptureEventRow,
} from './store.js';

/** The stable queue job type that drains the backlog. */
export const CAPTURE_DRAIN_JOB = 'capture.drain';

/** Applies one recorded event. 'deferred' = cannot yet (target not captured). */
export type CaptureReprocessor = (
  db: Queryable,
  event: CaptureEventRow,
) => Promise<'applied' | 'deferred'>;

const reprocessors = new Map<CaptureEventKind, CaptureReprocessor>();

/** Registers how a kind of event is applied. Called once by the dispatcher at wiring time. */
export function registerCaptureReprocessor(kind: CaptureEventKind, fn: CaptureReprocessor): void {
  reprocessors.set(kind, fn);
}

/** Test seam: forget all reprocessors. */
export function clearCaptureReprocessors(): void {
  reprocessors.clear();
}

export type ProcessOutcome = 'applied' | 'deferred' | 'failed' | 'dead';

/**
 * Applies a single event from its durable record and records the outcome. Shared
 * by the real-time path and the drain. Never throws: every failure is recorded on
 * the row (pending to retry, deferred to wait, or dead for the operator) so the
 * caller can keep going.
 */
export async function processEvent(db: Queryable, event: CaptureEventRow): Promise<ProcessOutcome> {
  const reprocessor = reprocessors.get(event.kind);
  if (!reprocessor) {
    // A programming error, not a data error: no handler for this kind. Record it so
    // it is visible, and stop retrying once attempts run out.
    log.error(`capture replay: no reprocessor registered for kind '${event.kind}' (event ${event.id}).`);
    const state = await failEvent(db, event.id, `no reprocessor registered for kind '${event.kind}'`);
    return state === 'dead' ? 'dead' : 'failed';
  }
  try {
    const result = await reprocessor(db, event);
    if (result === 'deferred') {
      const state = await deferEvent(db, event.id, 'target message not yet captured');
      return state === 'dead' ? 'dead' : 'deferred';
    }
    await markEventProcessed(db, event.id);
    return 'applied';
  } catch (err) {
    const emsg = err instanceof Error ? err.message : String(err);
    if (isPermanent(err)) {
      await deadLetterEvent(db, event.id, emsg);
      log.error(`capture replay: event ${event.id} (${event.kind}) is permanently unusable: ${emsg}`);
      return 'dead';
    }
    const state = await failEvent(db, event.id, emsg);
    return state === 'dead' ? 'dead' : 'failed';
  }
}

/**
 * Drains the unfinished backlog, applying events in ARRIVAL ORDER (CCB-S3-024 §4).
 *
 * Ordering rule: when an event FAILS transiently, its conversation is stalled for
 * the rest of the pass so a later event (an edit for the insert that just failed)
 * can never be applied ahead of it — next pass retries the failed one first. A
 * DEFERRED early deletion does NOT stall: it is waiting on a message that will
 * arrive as its own (independent) later event, which must be free to proceed. A
 * dead-lettered event is out of the set and does not stall either.
 *
 * Passes repeat while forward progress is being made, so a deletion that arrived
 * before its message (out-of-order delivery) is deferred on one pass and applied
 * on the next once the insert lands. Stops on the first pass with no progress; the
 * remainder is retried by a later drain. `stopping` lets an orderly shutdown bail.
 */
export async function drainCaptureEvents(
  db: Queryable,
  stopping: () => boolean = () => false,
): Promise<number> {
  let applied = 0;
  for (let pass = 0; pass < 100_000; pass++) {
    if (stopping()) break;
    const batch = await nextDrainBatch(db);
    if (batch.length === 0) break;
    const stalled = new Set<string>();
    let progressed = false;
    for (const event of batch) {
      if (stopping()) break;
      if (stalled.has(event.conversationKey)) continue; // preserve per-conversation order
      const outcome = await processEvent(db, event);
      if (outcome === 'applied') {
        progressed = true;
        applied++;
      } else if (outcome === 'failed') {
        stalled.add(event.conversationKey);
      }
      // 'deferred' and 'dead' do not stall the conversation.
    }
    if (!progressed) break; // no event moved forward this pass; leave the rest for the next drain
  }
  return applied;
}

/** The queue job: drain the capture backlog. Idempotent and safe to run concurrently. */
export const captureDrainHandler: JobHandler = async (_payload, ctx) => {
  const applied = await drainCaptureEvents(getPool(), () => ctx.stopping());
  if (applied > 0) log.info(`Capture drain: applied ${applied} recorded event(s).`);
};
