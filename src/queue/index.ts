/**
 * Job queue — public surface (CCB-S3-022). Registers the built-in handlers and
 * starts one worker in the shared process. Callers enqueue through the helpers
 * here; nothing else needs to know the store or the worker exist.
 */

import type { Queryable } from '../db/pool.js';
import { QueueWorker } from './worker.js';
import { getJobHandler, registerJobHandler } from './registry.js';
import { enqueueJob } from './store.js';
import { DEFAULT_QUEUE_CONFIG, type EnqueueOptions, type JobLane, type QueueConfig } from './types.js';
import {
  CONTENT_ANALYSIS_JOB,
  contentAnalysisHandler,
  contentAnalysisKey,
} from './jobs/analysis.js';
import { DELETION_APPLY_JOB, deletionApplyHandler, deletionApplyKey } from './jobs/deletion.js';

let worker: QueueWorker | undefined;

/** Register the built-in job handlers. Idempotent, so a second call is harmless. */
export function registerBuiltinJobs(): void {
  if (!getJobHandler(CONTENT_ANALYSIS_JOB)) {
    registerJobHandler(CONTENT_ANALYSIS_JOB, contentAnalysisHandler);
  }
  // Durable in-group deletion retry (CCB-S3-023 follow-up).
  if (!getJobHandler(DELETION_APPLY_JOB)) {
    registerJobHandler(DELETION_APPLY_JOB, deletionApplyHandler);
  }
  // The media-derivative handler is registered when its migration lands (§5).
}

export interface QueueDeps {
  db: Queryable;
  /** Live config provider; defaults to the shipped defaults until the admin page edits them. */
  config?: () => QueueConfig;
}

/** Starts (or returns) the single process-wide worker. */
export async function startQueue(deps: QueueDeps): Promise<QueueWorker> {
  if (worker) return worker;
  registerBuiltinJobs();
  worker = new QueueWorker({ db: deps.db, config: deps.config ?? (() => DEFAULT_QUEUE_CONFIG) });
  await worker.start();
  return worker;
}

export async function stopQueue(): Promise<void> {
  if (worker) await worker.stop();
  worker = undefined;
}

/** A thin, typed enqueue for callers that do not want the raw store. */
export async function enqueue(
  db: Queryable,
  type: string,
  opts: EnqueueOptions,
): Promise<{ id: number; created: boolean }> {
  return enqueueJob(db, type, opts);
}

/**
 * The content-analysis attach point (§7). Capture and publication call this so the
 * future AI work needs no change to the capture pipeline. Idempotent per message.
 */
export async function enqueueContentAnalysis(
  db: Queryable,
  messageId: number,
  lane: JobLane = 'bulk',
): Promise<void> {
  await enqueueJob(db, CONTENT_ANALYSIS_JOB, {
    idempotencyKey: contentAnalysisKey(messageId),
    lane,
    payload: { messageId },
  });
}

/**
 * Enqueue a durable retry of an in-group deletion (CCB-S3-023 follow-up). Called
 * when the immediate `markDeleted` fails, so the deletion is applied when the DB
 * recovers instead of being lost with the un-redelivered SDK event. Interactive
 * lane: consent is not bulk work. Idempotent per (group, message-set).
 */
export async function enqueueDeletionRetry(
  db: Queryable,
  groupId: number,
  groupMsgIds: readonly number[],
): Promise<void> {
  await enqueueJob(db, DELETION_APPLY_JOB, {
    idempotencyKey: deletionApplyKey(groupId, groupMsgIds),
    lane: 'interactive',
    payload: { groupId, groupMsgIds: [...groupMsgIds] },
  });
}

export { CONTENT_ANALYSIS_JOB } from './jobs/analysis.js';
export { DELETION_APPLY_JOB } from './jobs/deletion.js';
