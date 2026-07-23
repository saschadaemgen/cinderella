/**
 * Job queue — the worker runtime (CCB-S3-022).
 *
 * One worker per process. It polls for claimable jobs, runs their handlers, and
 * enforces the limits that keep a backlog from taking the shared process down:
 *   - the GLOBAL limit caps how many jobs run at once (CPU / memory / DB conns);
 *   - the PER-TYPE limit stops one heavy type occupying every slot;
 *   - the bulk lane can be PAUSED, while interactive work keeps flowing.
 * In-flight counts are tracked in memory (this is the single claimant), so the
 * limits are exact. FOR UPDATE SKIP LOCKED still makes a second process safe.
 *
 * Crash recovery: on start it requeues anything the previous process left running,
 * and a periodic sweep requeues jobs whose lock has gone stale. A job that keeps
 * crashing the worker re-increments attempts each time and so eventually
 * dead-letters rather than looping forever.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { log } from '../log.js';
import { getJobHandler, registeredJobTypes } from './registry.js';
import { claimJob, completeJob, failJob, requeueStuck } from './store.js';
import { isPermanent, PermanentJobError, type Job, type JobContext, type QueueConfig } from './types.js';

export interface WorkerDeps {
  db: Queryable;
  /** Read fresh each tick, so an admin edit (pause, limits) takes effect live. */
  config: () => QueueConfig;
  /** Override the worker id (tests); defaults to a per-process id. */
  workerId?: string;
}

export class QueueWorker {
  private readonly db: Queryable;
  private readonly getConfig: () => QueueConfig;
  private readonly workerId: string;
  private readonly inFlight = new Map<string, number>();
  private total = 0;
  private stopping = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private ticking = false;
  private reTick = false;

  constructor(deps: WorkerDeps) {
    this.db = deps.db;
    this.getConfig = deps.config;
    this.workerId = deps.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  }

  /** Requeue anything left running by the previous process, then begin polling. */
  async start(): Promise<void> {
    const requeued = await requeueStuck(this.db, 0); // startup: all running -> queued
    if (requeued > 0) {
      log.warn(`Queue: requeued ${requeued} job(s) left running by a previous process.`);
    }
    this.stopping = false;
    const cfg = this.getConfig();
    this.pollTimer = setInterval(() => void this.tick(), cfg.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    this.sweepTimer = setInterval(() => {
      const c = this.getConfig();
      void requeueStuck(this.db, c.stuckAfterMs)
        .then((n) => {
          if (n > 0) log.warn(`Queue: swept ${n} stuck job(s) (lock older than the threshold).`);
        })
        .catch(() => undefined);
    }, Math.max(30_000, Math.floor(cfg.stuckAfterMs / 4)));
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    void this.tick();
    log.info(`Queue: worker ${this.workerId} started (global ${cfg.globalConcurrency}, poll ${cfg.pollIntervalMs}ms).`);
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    return Promise.resolve();
  }

  private running(type: string): number {
    return this.inFlight.get(type) ?? 0;
  }

  /** How many jobs this worker has running (for the health page / tests). */
  get inFlightTotal(): number {
    return this.total;
  }

  /**
   * Claim as much as the limits allow and run each. Single-flight per tick; if a
   * slot frees while a tick is in progress, `reTick` schedules one more pass so a
   * freed slot never waits a full poll interval to be refilled.
   */
  private async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.ticking) {
      this.reTick = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.reTick = false;
        const cfg = this.getConfig();
        const types = registeredJobTypes();
        for (let guard = 0; guard < cfg.globalConcurrency + 8; guard++) {
          if (this.stopping || this.total >= cfg.globalConcurrency) break;
          const eligible = types.filter(
            (t) => this.running(t) < (cfg.perType[t] ?? cfg.defaultPerType),
          );
          if (eligible.length === 0) break;
          const job = await claimJob(this.db, this.workerId, eligible, !cfg.bulkPaused);
          if (!job) break;
          this.inFlight.set(job.type, this.running(job.type) + 1);
          this.total++;
          void this.run(job, cfg);
        }
      } while (this.reTick && !this.stopping);
    } catch (err) {
      log.warn(`Queue: tick error (${err instanceof Error ? err.message : String(err)}).`);
    } finally {
      this.ticking = false;
    }
  }

  private async run(job: Job, cfg: QueueConfig): Promise<void> {
    const ctx: JobContext = { job, stopping: () => this.stopping };
    try {
      const handler = getJobHandler(job.type);
      if (!handler) throw new PermanentJobError(`no handler registered for job type "${job.type}"`);
      await handler(job.payload, ctx);
      await completeJob(this.db, job.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const outcome = await failJob(this.db, job, msg, isPermanent(err), cfg.backoff).catch((e) => {
        log.error(`Queue: could not record failure for job ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
        return 'retry' as const;
      });
      if (outcome === 'dead') {
        log.warn(`Queue: job ${job.id} (${job.type}) dead-lettered: ${msg}`);
      }
    } finally {
      this.inFlight.set(job.type, Math.max(0, this.running(job.type) - 1));
      this.total = Math.max(0, this.total - 1);
      if (!this.stopping) void this.tick(); // a slot freed; look for more now
    }
  }
}
