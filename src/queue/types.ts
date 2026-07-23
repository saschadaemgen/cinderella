/**
 * Job queue — shared types (CCB-S3-022).
 *
 * The queue is deliberately boring: PostgreSQL-backed, single process, one
 * database, claimed with FOR UPDATE SKIP LOCKED. These types are the contract
 * between the store (SQL), the worker (runtime), and the handlers (the actual
 * work). Nothing here imports the SimpleX SDK or any provider.
 */

export type JobState = 'queued' | 'running' | 'succeeded' | 'dead' | 'cancelled';

/** Coarse priority lane. Interactive is always claimed before bulk (§3). */
export type JobLane = 'interactive' | 'bulk';

/** A job as the worker receives it to run. */
export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  lane: JobLane;
  /** How many times it has now been attempted (this run included). */
  attempts: number;
  maxAttempts: number;
}

/**
 * Thrown by a handler when the failure is PERMANENT — a file that no longer
 * exists, a payload that can never be valid. The worker dead-letters it
 * immediately instead of consuming the full backoff schedule (§2). This is the
 * same permanent-vs-transient distinction CCB-S3-018 needs for expired file
 * receipts; it lives here so both can reuse it.
 */
export class PermanentJobError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** True for a PermanentJobError (survives across module/instanceof boundaries). */
export function isPermanent(err: unknown): boolean {
  return (
    err instanceof PermanentJobError ||
    (typeof err === 'object' && err !== null && (err as { permanent?: unknown }).permanent === true)
  );
}

/** Everything a handler is given. Kept minimal on purpose. */
export interface JobContext {
  job: Job;
  /** Structured, cancellable signal for long work (set false when the worker stops). */
  readonly stopping: () => boolean;
}

/**
 * A handler does the work for one job type. It MUST be idempotent: a repeat run
 * (after a crash, a restart, or a manual retry) must produce the same result
 * rather than duplicating work (§4). Throw {@link PermanentJobError} for a failure
 * that will never succeed; throw anything else for a transient one (which backs
 * off and retries).
 */
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

/** Options when enqueuing. `idempotencyKey` dedupes against live jobs of the same type. */
export interface EnqueueOptions {
  idempotencyKey: string;
  lane?: JobLane;
  priority?: number;
  maxAttempts?: number;
  /** Delay the first run until this instant (defaults to now). */
  runAt?: Date;
  payload?: Record<string, unknown>;
}

/** Backoff shape — configurable so tests can use tiny values. */
export interface BackoffConfig {
  baseMs: number;
  factor: number;
  capMs: number;
  /** Fractional jitter (0..1); 0 = deterministic (for tests). */
  jitter: number;
}

/** Live worker configuration (read fresh each tick, so admin edits take effect). */
export interface QueueConfig {
  /** Ceiling on jobs running at once, across all types (§3). */
  globalConcurrency: number;
  /** Per-type ceiling; falls back to `defaultPerType`. */
  perType: Record<string, number>;
  defaultPerType: number;
  /** When true, bulk-lane jobs are not claimed; interactive still runs (§3). */
  bulkPaused: boolean;
  /** How often the worker looks for work when idle. */
  pollIntervalMs: number;
  /** A running job older than this is "stuck" (crashed worker) — swept + surfaced. */
  stuckAfterMs: number;
  backoff: BackoffConfig;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  globalConcurrency: 4,
  perType: {},
  defaultPerType: 2,
  bulkPaused: false,
  pollIntervalMs: 500,
  stuckAfterMs: 5 * 60 * 1000,
  backoff: { baseMs: 2000, factor: 2, capMs: 5 * 60 * 1000, jitter: 0.2 },
};

/** next run delay for a given (1-based) attempt number, with optional jitter. */
export function backoffMs(cfg: BackoffConfig, attempt: number): number {
  const raw = cfg.baseMs * Math.pow(cfg.factor, Math.max(0, attempt - 1));
  const capped = Math.min(cfg.capMs, raw);
  if (cfg.jitter <= 0) return Math.round(capped);
  const delta = capped * cfg.jitter;
  // Jitter in [-delta, +delta], never below baseMs/2.
  const jittered = capped - delta + Math.random() * 2 * delta;
  return Math.max(Math.round(cfg.baseMs / 2), Math.round(jittered));
}
