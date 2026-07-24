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

/**
 * THE OWNERSHIP FENCE. A run may write the job's outcome ONLY if it still owns the
 * claim: same worker, same attempt number, still `running`. `attempts` is the fence
 * token — every claim increments it, so a run that was reclaimed and superseded by a
 * fresh run finds no match and its write is a no-op. Without this, a stale/zombie
 * run finishing late could flip a newer run's row (a succeeded job back to queued,
 * or a live job to dead). Every terminal write below carries the fence.
 */
const FENCE = `id = $1 AND state = 'running' AND locked_by = $2 AND attempts = $3`;

/** Marks a job done, iff this run still owns it. Returns false when superseded. */
export async function completeJob(
  db: Queryable,
  job: Pick<Job, 'id' | 'attempts'>,
  workerId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'succeeded', locked_at = NULL, locked_by = NULL,
            completed_at = now(), updated_at = now(), last_error = NULL
      WHERE ${FENCE}`,
    [job.id, workerId, job.attempts],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Records a failed run, iff this run still owns the claim (the fence). A PERMANENT
 * failure, or one that has used its last attempt, dead-letters immediately (kept for
 * the operator, never retried nor deleted); otherwise the job is requeued with an
 * exponential-backoff `run_at`. Returns 'dead' / 'retry', or 'superseded' when the
 * fence did not match (this run had already lost its claim, so it changed nothing).
 */
export async function failJob(
  db: Queryable,
  job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>,
  workerId: string,
  errorMessage: string,
  permanent: boolean,
  backoff: BackoffConfig,
): Promise<'dead' | 'retry' | 'superseded'> {
  const err = errorMessage.slice(0, 2000);
  if (permanent || job.attempts >= job.maxAttempts) {
    const { rowCount } = await db.query(
      `UPDATE jobs
          SET state = 'dead', locked_at = NULL, locked_by = NULL,
              completed_at = now(), updated_at = now(), last_error = $4
        WHERE ${FENCE}`,
      [job.id, workerId, job.attempts, permanent ? `permanent: ${err}` : err],
    );
    return (rowCount ?? 0) > 0 ? 'dead' : 'superseded';
  }
  const delay = backoffMs(backoff, job.attempts);
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'queued', locked_at = NULL, locked_by = NULL,
            run_at = now() + ($5 || ' milliseconds')::interval,
            updated_at = now(), last_error = $4
      WHERE ${FENCE}`,
    [job.id, workerId, job.attempts, err, String(delay)],
  );
  return (rowCount ?? 0) > 0 ? 'retry' : 'superseded';
}

export interface ReclaimResult {
  requeued: number;
  deadLettered: number;
}

/** Per-type thresholds as a JSON map with every value floored to a non-negative
 *  integer ms — a float would make the `::bigint` cast throw and abort the whole
 *  reclaim/health query. Mirrors the flooring applied to the default. */
function thresholdsJson(perTypeMs: Record<string, number>): string {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(perTypeMs ?? {})) {
    clean[k] = Math.max(0, Math.floor(Number(v) || 0));
  }
  return JSON.stringify(clean);
}

/**
 * Reclaims jobs abandoned by a crashed or stalled worker. A `running` job whose
 * lock is older than its PER-TYPE threshold is orphaned; `perTypeMs` maps type to
 * ms and `defaultMs` is the fallback. The threshold must exceed the slowest
 * legitimate run of that type, or a long job is reclaimed while still working and
 * runs twice.
 *
 * An orphan that has already used its whole attempt budget is DEAD-LETTERED with a
 * distinct reason (it kept crashing or stalling the worker); one still within budget
 * is requeued to run again. Because a claim increments `attempts`, a job that
 * crashes the worker every time consumes a retry each time and so dead-letters after
 * `max_attempts` crashes rather than looping forever (poison-message protection) —
 * the same total tries as a job whose handler throws every time.
 *
 * `excludeWorkerId` is the CURRENTLY LIVE worker: a job it still holds is NOT
 * reclaimed however old the lock is, because if this alive process holds the lock
 * the handler is still running (slow), not crashed. That is what stops a legitimately
 * long job being reclaimed and double-run. Startup recovery passes the new process's
 * id (which holds nothing yet) with `defaultMs = 0`, so it reclaims EVERY job left
 * running by the PREVIOUS process (different worker id) regardless of age.
 */
export async function reclaimOrphans(
  db: Queryable,
  perTypeMs: Record<string, number>,
  defaultMs: number,
  excludeWorkerId: string,
): Promise<ReclaimResult> {
  const thresholds = thresholdsJson(perTypeMs);
  const def = String(Math.max(0, Math.floor(defaultMs)));
  // Per-row orphan test: held by someone OTHER than the live worker, and its lock is
  // older than this type's threshold (or the default).
  // `<=` (not `<`) so that with defaultMs=0 the test reduces to `locked_at <= now()`,
  // which every running row satisfies — startup recovery then deterministically
  // reclaims ALL jobs left by the previous process, even one locked in the same tick.
  const orphaned = `state = 'running'
       AND locked_by IS DISTINCT FROM $3
       AND locked_at <= now() - ((COALESCE(($1::jsonb ->> type)::bigint, $2::bigint)) || ' milliseconds')::interval`;
  const dead = await db.query(
    `UPDATE jobs
        SET state = 'dead', locked_at = NULL, locked_by = NULL,
            completed_at = now(), updated_at = now(),
            last_error = 'gave up after ' || attempts
                         || ' interrupted run(s): the worker crashed or stalled during this job'
      WHERE ${orphaned} AND attempts >= max_attempts`,
    [thresholds, def, excludeWorkerId],
  );
  const requeued = await db.query(
    `UPDATE jobs
        SET state = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now(),
            last_error = 'requeued after interruption (worker crashed or stalled)'
      WHERE ${orphaned} AND attempts < max_attempts`,
    [thresholds, def, excludeWorkerId],
  );
  return { requeued: requeued.rowCount ?? 0, deadLettered: dead.rowCount ?? 0 };
}

/**
 * Orderly-shutdown drain: requeue the jobs this worker is running, WITHOUT counting
 * it as an attempt (a deploy is not a failure). Rolls back the claim's attempt
 * increment and clears the lock, so on the next start these are plain `queued` jobs,
 * not orphans to be dead-lettered. Fenced to this worker's own locks.
 */
export async function drainInFlight(
  db: Queryable,
  ids: readonly number[],
  workerId: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'queued', locked_at = NULL, locked_by = NULL,
            attempts = GREATEST(0, attempts - 1), run_at = now(), updated_at = now(),
            last_error = 'requeued for an orderly shutdown (not counted as an attempt)'
      WHERE id = ANY($1::bigint[]) AND state = 'running' AND locked_by = $2`,
    [[...ids], workerId],
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

export async function queueHealth(
  db: Queryable,
  perTypeMs: Record<string, number>,
  defaultMs: number,
): Promise<QueueHealth> {
  const { rows } = await db.query<{
    queued: string; running: string; dead: string; stuck: string;
    succ: string; wait: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE state='queued')                                        AS queued,
       count(*) FILTER (WHERE state='running')                                       AS running,
       count(*) FILTER (WHERE state='dead')                                          AS dead,
       -- A running job past ITS per-type patience is stuck (a crashed/stalled worker).
       count(*) FILTER (WHERE state='running'
                        AND locked_at <= now()
                            - ((COALESCE(($1::jsonb ->> type)::bigint, $2::bigint)) || ' milliseconds')::interval) AS stuck,
       count(*) FILTER (WHERE state='succeeded' AND completed_at > now() - interval '1 hour') AS succ,
       EXTRACT(EPOCH FROM (now() - min(run_at) FILTER (WHERE state='queued' AND run_at <= now()))) AS wait
     FROM jobs`,
    [thresholdsJson(perTypeMs), String(Math.max(0, Math.floor(defaultMs)))],
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
