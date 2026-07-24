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
import { claimJob, completeJob, drainInFlight, failJob, reclaimOrphans } from './store.js';
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
  /** The ids this worker currently has running — for graceful drain + reclaim-exclude. */
  private readonly inFlightIds = new Set<number>();
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

  /** Recover anything left running by the previous process, then begin polling. */
  async start(): Promise<void> {
    // Startup: the process just began with a NEW worker id, so every job still
    // 'running' was left by the PREVIOUS process (different id) and is orphaned.
    // Reclaim all (threshold 0); any that had exhausted their attempts dead-letter.
    const { requeued, deadLettered } = await reclaimOrphans(this.db, {}, 0, this.workerId);
    if (requeued > 0 || deadLettered > 0) {
      log.warn(
        `Queue: recovered ${requeued + deadLettered} job(s) left running by a previous process ` +
          `(${requeued} requeued, ${deadLettered} dead-lettered after repeated interruptions).`,
      );
    }
    this.stopping = false;
    const cfg = this.getConfig();
    this.pollTimer = setInterval(() => void this.tick(), cfg.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    this.sweepTimer = setInterval(() => {
      const c = this.getConfig();
      // Exclude THIS live worker's own locks: a job it still holds is slow, not
      // crashed, and reclaiming it would double-run it. Only jobs held by a vanished
      // worker (or none) are eligible.
      void reclaimOrphans(this.db, c.perTypeStuckMs, c.defaultStuckMs, this.workerId)
        .then(({ requeued: r, deadLettered: d }) => {
          if (r > 0 || d > 0) {
            log.warn(
              `Queue: reclaimed ${r + d} orphaned job(s) (${r} requeued, ${d} dead-lettered after ` +
                `crashing or stalling the worker past their per-type threshold).`,
            );
          }
        })
        .catch((e) =>
          log.warn(`Queue: orphan-reclaim sweep failed: ${e instanceof Error ? e.message : String(e)}`),
        );
    }, Math.max(30_000, Math.floor(cfg.defaultStuckMs / 4)));
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    void this.tick();
    log.info(`Queue: worker ${this.workerId} started (global ${cfg.globalConcurrency}, poll ${cfg.pollIntervalMs}ms).`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // Orderly shutdown: requeue the jobs we are running WITHOUT counting an attempt,
    // so a deploy restart neither dead-letters a single-attempt job nor erodes a
    // retry budget. Their handlers may still be executing; the ownership fence makes
    // their late completeJob/failJob a no-op, so they simply re-run next start.
    try {
      const drained = await drainInFlight(this.db, [...this.inFlightIds], this.workerId);
      if (drained > 0) {
        log.info(`Queue: requeued ${drained} in-flight job(s) for an orderly shutdown (no attempt spent).`);
      }
    } catch (err) {
      log.warn(`Queue: drain on shutdown failed (${err instanceof Error ? err.message : String(err)}).`);
    }
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
          this.inFlightIds.add(job.id);
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
      const ok = await completeJob(this.db, job, this.workerId);
      if (!ok) {
        log.debug(`Queue: job ${job.id} finished but its claim was superseded (reclaimed); result dropped.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const outcome = await failJob(this.db, job, this.workerId, msg, isPermanent(err), cfg.backoff).catch(
        (e) => {
          log.error(`Queue: could not record failure for job ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
          return 'retry' as const;
        },
      );
      if (outcome === 'dead') log.warn(`Queue: job ${job.id} (${job.type}) dead-lettered: ${msg}`);
      else if (outcome === 'superseded') {
        log.debug(`Queue: job ${job.id} failed but its claim was superseded; ignored.`);
      }
    } finally {
      this.inFlightIds.delete(job.id);
      this.inFlight.set(job.type, Math.max(0, this.running(job.type) - 1));
      this.total = Math.max(0, this.total - 1);
      if (!this.stopping) void this.tick(); // a slot freed; look for more now
    }
  }
}
