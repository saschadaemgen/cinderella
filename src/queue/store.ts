/**
 * Job queue — the SQL. This is the only module that touches the `jobs` table.
 *
 * The claim is the heart of it:
 *
 *   UPDATE jobs SET state='running', locked_at=now(), locked_by=$w, attempts=attempts+1
 *    WHERE id = (SELECT id FROM jobs
 *                 WHERE state='queued' AND run_at<=now() AND type = ANY($types)
 *                   AND ($bulkAllowed OR lane='interactive')
 *                 ORDER BY lane, priority DESC, run_at, id
 *                 FOR UPDATE SKIP LOCKED LIMIT 1)
 *   RETURNING ...
 *
 * FOR UPDATE SKIP LOCKED means two workers pulling at the same instant skip each
 * other's locked row instead of blocking or double-claiming. `lane` sorts
 * interactive before bulk (enum order), so an interactive job is claimed ahead of
 * any bulk backlog. `type = ANY($types)` lets the worker exclude types already at
 * their per-type concurrency limit, and `$bulkAllowed` pauses the bulk lane.
 */

import type { Queryable } from '../db/pool.js';
import { backoffMs, type BackoffConfig, type Job, type EnqueueOptions } from './types.js';

interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  lane: Job['lane'];
  attempts: string | number;
  max_attempts: string | number;
}

function toJob(r: JobRow): Job {
  return {
    id: Number(r.id),
    type: r.type,
    payload: r.payload ?? {},
    lane: r.lane,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  };
}

/**
 * Enqueues a job, idempotently. Enqueuing the same (type, idempotencyKey) while a
 * live (queued/running) job with that key exists does NOT create a second job — it
 * returns the existing id with `created:false`. A terminal job never blocks a fresh
 * enqueue of the same key.
 */
export async function enqueueJob(
  db: Queryable,
  type: string,
  opts: EnqueueOptions,
): Promise<{ id: number; created: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, lane, priority, max_attempts, run_at, idempotency_key)
     VALUES ($1, $2::jsonb, $3::job_lane, $4, $5, COALESCE($6, now()), $7)
     ON CONFLICT (type, idempotency_key) WHERE state IN ('queued', 'running')
     DO NOTHING
     RETURNING id`,
    [
      type,
      JSON.stringify(opts.payload ?? {}),
      opts.lane ?? 'bulk',
      opts.priority ?? 0,
      opts.maxAttempts ?? 5,
      opts.runAt ? opts.runAt.toISOString() : null,
      opts.idempotencyKey,
    ],
  );
  if (inserted.rows[0]) return { id: Number(inserted.rows[0].id), created: true };
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM jobs
      WHERE type = $1 AND idempotency_key = $2 AND state IN ('queued', 'running')
      ORDER BY id LIMIT 1`,
    [type, opts.idempotencyKey],
  );
  return { id: Number(existing.rows[0]?.id ?? 0), created: false };
}

/**
 * Claims the next runnable job for this worker, or null when there is nothing to
 * do. `eligibleTypes` are the types NOT already at their per-type concurrency
 * limit; `bulkAllowed` is false when the bulk lane is paused or the global limit is
 * reached, so only interactive work is taken.
 */
export async function claimJob(
  db: Queryable,
  workerId: string,
  eligibleTypes: readonly string[],
  bulkAllowed: boolean,
): Promise<Job | null> {
  if (eligibleTypes.length === 0) return null;
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET state = 'running', locked_at = now(), locked_by = $1,
            attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM jobs
         WHERE state = 'queued'
           AND run_at <= now()
           AND type = ANY($2::text[])
           AND ($3::boolean OR lane = 'interactive')
         ORDER BY lane, priority DESC, run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, type, payload, lane, attempts, max_attempts`,
    [workerId, [...eligibleTypes], bulkAllowed],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Marks a job done. */
export async function completeJob(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET state = 'succeeded', locked_at = NULL, locked_by = NULL,
            completed_at = now(), updated_at = now(), last_error = NULL
      WHERE id = $1`,
    [id],
  );
}

/**
 * Records a failed run. A PERMANENT failure, or one that has used its last attempt,
 * dead-letters immediately (state 'dead', kept for the operator, never retried nor
 * deleted). Otherwise the job is requeued with an exponential-backoff `run_at`.
 * Returns which happened.
 */
export async function failJob(
  db: Queryable,
  job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>,
  errorMessage: string,
  permanent: boolean,
  backoff: BackoffConfig,
): Promise<'dead' | 'retry'> {
  const err = errorMessage.slice(0, 2000);
  if (permanent || job.attempts >= job.maxAttempts) {
    await db.query(
      `UPDATE jobs
          SET state = 'dead', locked_at = NULL, locked_by = NULL,
              completed_at = now(), updated_at = now(), last_error = $2
        WHERE id = $1`,
      [job.id, permanent ? `permanent: ${err}` : err],
    );
    return 'dead';
  }
  const delay = backoffMs(backoff, job.attempts);
  await db.query(
    `UPDATE jobs
        SET state = 'queued', locked_at = NULL, locked_by = NULL,
            run_at = now() + ($3 || ' milliseconds')::interval,
            updated_at = now(), last_error = $2
      WHERE id = $1`,
    [job.id, err, String(delay)],
  );
  return 'retry';
}

/**
 * Crash recovery. Returns 'running' jobs to 'queued' so a worker that vanished
 * mid-flight does not strand its work. `olderThanMs <= 0` requeues ALL running jobs
 * (startup recovery in a single-process deployment); a positive value requeues only
 * those whose lock is older than the threshold (a periodic sweep, and the basis for
 * the stuck-job indicator). The next claim re-increments attempts, so a job that
 * keeps crashing the worker eventually dead-letters rather than looping forever.
 */
export async function requeueStuck(db: Queryable, olderThanMs: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now(),
            last_error = 'requeued after interruption (was running)'
      WHERE state = 'running'
        AND ($1 <= 0 OR locked_at < now() - ($1 || ' milliseconds')::interval)`,
    [olderThanMs],
  );
  return rowCount ?? 0;
}

/* ── Observability + operator actions ────────────────────────────────────── */

export interface QueueDepthRow {
  type: string;
  lane: Job['lane'];
  state: JobStateName;
  count: number;
}
type JobStateName = 'queued' | 'running' | 'succeeded' | 'dead' | 'cancelled';

/** Depth by (type, lane, state) — the shape the admin page groups. */
export async function queueDepth(db: Queryable): Promise<QueueDepthRow[]> {
  const { rows } = await db.query<{ type: string; lane: Job['lane']; state: JobStateName; n: string }>(
    `SELECT type, lane, state::text AS state, count(*)::int AS n
       FROM jobs GROUP BY type, lane, state ORDER BY type, lane, state`,
  );
  return rows.map((r) => ({ type: r.type, lane: r.lane, state: r.state, count: Number(r.n) }));
}

export interface QueueHealth {
  queued: number;
  running: number;
  dead: number;
  /** Running jobs whose lock is older than the stuck threshold (crashed workers). */
  stuck: number;
  /** Succeeded in the last hour (throughput). */
  succeededLastHour: number;
  /** Oldest queued job's wait, in seconds (how long work waits to be claimed). */
  oldestQueuedWaitSeconds: number | null;
}

export async function queueHealth(db: Queryable, stuckAfterMs: number): Promise<QueueHealth> {
  const { rows } = await db.query<{
    queued: string; running: string; dead: string; stuck: string;
    succ: string; wait: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE state='queued')                                        AS queued,
       count(*) FILTER (WHERE state='running')                                       AS running,
       count(*) FILTER (WHERE state='dead')                                          AS dead,
       count(*) FILTER (WHERE state='running'
                        AND locked_at < now() - ($1 || ' milliseconds')::interval)   AS stuck,
       count(*) FILTER (WHERE state='succeeded' AND completed_at > now() - interval '1 hour') AS succ,
       EXTRACT(EPOCH FROM (now() - min(run_at) FILTER (WHERE state='queued' AND run_at <= now()))) AS wait
     FROM jobs`,
    [String(stuckAfterMs)],
  );
  const r = rows[0];
  return {
    queued: Number(r?.queued ?? 0),
    running: Number(r?.running ?? 0),
    dead: Number(r?.dead ?? 0),
    stuck: Number(r?.stuck ?? 0),
    succeededLastHour: Number(r?.succ ?? 0),
    oldestQueuedWaitSeconds: r?.wait == null ? null : Math.max(0, Math.round(Number(r.wait))),
  };
}

export interface DeadLetter {
  id: number;
  type: string;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export async function listDeadLetters(db: Queryable, limit = 100): Promise<DeadLetter[]> {
  const { rows } = await db.query<{ id: string; type: string; attempts: string; last_error: string | null; updated_at: string }>(
    `SELECT id, type, attempts, last_error, updated_at
       FROM jobs WHERE state = 'dead' ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    attempts: Number(r.attempts),
    lastError: r.last_error,
    updatedAt: r.updated_at,
  }));
}

/** Operator: put a dead job back in the queue, attempts reset, to run now. */
export async function retryJob(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'queued', attempts = 0, run_at = now(),
            locked_at = NULL, locked_by = NULL, completed_at = NULL,
            last_error = NULL, updated_at = now()
      WHERE id = $1 AND state = 'dead'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Operator: cancel a job that is queued or dead. Running jobs finish on their own. */
export async function cancelJob(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'cancelled', completed_at = now(), updated_at = now()
      WHERE id = $1 AND state IN ('queued', 'dead')`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}
