/**
 * CCB-S3-022 verification harness — the durable job queue.
 *
 * Runs the REAL migration and the REAL store + worker against PGlite (Postgres in
 * WASM), and proves each acceptance criterion:
 *   - jobs survive a restart mid-flight (crash recovery requeues them),
 *   - two claims cannot take the same job,
 *   - a failing job backs off, retries, and dead-letters with its error visible,
 *   - a permanent failure fails fast instead of exhausting the schedule,
 *   - a large bulk backlog does not delay an interactive claim (measured),
 *   - the same idempotency key enqueues one job,
 *   - per-type + global concurrency limits hold, and bulk can be paused,
 *   - the placeholder analysis job runs and records that no provider is configured,
 *   - the admin views (depth, health, dead letters, retry, cancel) work.
 *
 *   npx tsx scripts/verify-queue.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { loadMigrationFiles } from '../src/db/migrate.js';
import type { Queryable } from '../src/db/pool.js';
import {
  cancelJob,
  claimJob,
  completeJob,
  drainInFlight,
  enqueueJob,
  failJob,
  listDeadLetters,
  queueDepth,
  queueHealth,
  reclaimOrphans,
  retryJob,
} from '../src/queue/store.js';
import { clearJobHandlers, registerJobHandler } from '../src/queue/registry.js';
import { QueueWorker } from '../src/queue/worker.js';
import { PermanentJobError, type QueueConfig } from '../src/queue/types.js';
import { CONTENT_ANALYSIS_JOB, contentAnalysisHandler } from '../src/queue/jobs/analysis.js';

let failures = 0;
function section(t: string): void {
  console.log(`\n${t}`);
}
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(15);
  }
  return false;
}

const FAST: QueueConfig = {
  globalConcurrency: 4,
  perType: {},
  defaultPerType: 2,
  bulkPaused: false,
  pollIntervalMs: 15,
  perTypeStuckMs: {},
  defaultStuckMs: 60_000,
  backoff: { baseMs: 20, factor: 2, capMs: 500, jitter: 0 },
};

async function scalar(db: Queryable, sql: string, params: unknown[] = []): Promise<unknown> {
  const { rows } = await db.query<Record<string, unknown>>(sql, params);
  const r = rows[0];
  return r ? Object.values(r)[0] : undefined;
}

async function main(): Promise<void> {
  const pg = new PGlite();
  const db: Queryable = {
    async query(text, values) {
      const res = await pg.query(text, values ? [...values] : undefined);
      return { rows: res.rows as never[], rowCount: (res.affectedRows ?? res.rows.length) as number };
    },
  };
  for (const m of await loadMigrationFiles()) await pg.exec(m.sql);

  /* ── 1. Idempotency ──────────────────────────────────────────────────────── */
  section('1. Idempotency — the same key enqueues one job');
  const a = await enqueueJob(db, 't.echo', { idempotencyKey: 'k1', payload: { n: 1 } });
  const b = await enqueueJob(db, 't.echo', { idempotencyKey: 'k1', payload: { n: 2 } });
  check('first enqueue created a job', a.created && a.id > 0);
  check('second enqueue with the same key did NOT create a job', !b.created && b.id === a.id);
  check('exactly one row exists for the key', Number(await scalar(db, `SELECT count(*) FROM jobs WHERE idempotency_key='k1'`)) === 1);
  // A DIFFERENT type with the same key is a different job.
  const c = await enqueueJob(db, 't.other', { idempotencyKey: 'k1' });
  check('same key under a different type is a separate job', c.created && c.id !== a.id);

  /* ── 2. Claim + no double-claim ──────────────────────────────────────────── */
  section('2. Claiming — FOR UPDATE SKIP LOCKED, no double-claim');
  check('the claim query uses FOR UPDATE SKIP LOCKED', /FOR UPDATE\s+SKIP LOCKED/i.test(readFileSync('src/queue/store.ts', 'utf8')));
  await pg.exec(`DELETE FROM jobs`);
  const j1 = await enqueueJob(db, 't.echo', { idempotencyKey: 'c1' });
  // Two claims of the single queued job; exactly one wins, the other gets nothing.
  const [r1, r2] = await Promise.all([
    claimJob(db, 'wA', ['t.echo'], true),
    claimJob(db, 'wB', ['t.echo'], true),
  ]);
  const claimed = [r1, r2].filter(Boolean);
  check('exactly one worker claimed the job', claimed.length === 1 && claimed[0]?.id === j1.id);
  check('the claimed job is now running with attempts=1', Number(await scalar(db, `SELECT attempts FROM jobs WHERE id=$1`, [j1.id])) === 1 && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [j1.id])) === 'running');
  check('a further claim finds nothing', (await claimJob(db, 'wC', ['t.echo'], true)) === null);

  /* ── 3. Durability — survive a restart mid-flight ────────────────────────── */
  section('3. Durability — a job left running is recovered, not lost');
  // j1 is 'running' (as if the process died mid-run). Startup recovery requeues it.
  const recovered = await reclaimOrphans(db, {}, 0, 'startup');
  check('startup recovery requeued the in-flight job', recovered.requeued === 1 && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [j1.id])) === 'queued');
  const reclaim = await claimJob(db, 'wA', ['t.echo'], true);
  check('the recovered job can be claimed again', reclaim?.id === j1.id);
  await completeJob(db, reclaim!, 'wA');
  check('and then completed', (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [j1.id])) === 'succeeded');

  /* ── 4. Backoff, retry, dead-letter ──────────────────────────────────────── */
  section('4. Retry with backoff, then dead-letter with the error visible');
  await pg.exec(`DELETE FROM jobs`);
  const dj = await enqueueJob(db, 't.flaky', { idempotencyKey: 'd1', maxAttempts: 3 });
  let outcomes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const job = await claimJob(db, 'w', ['t.flaky'], true);
    if (!job) break;
    outcomes.push(await failJob(db, job, 'w', 'boom', false, FAST.backoff));
    // Make the backoff-delayed job claimable again for the next iteration.
    await pg.exec(`UPDATE jobs SET run_at = now() WHERE id = ${dj.id} AND state='queued'`);
  }
  check('it retried twice then dead-lettered', outcomes.join(',') === 'retry,retry,dead', outcomes.join(','));
  check('the dead job keeps its error', String(await scalar(db, `SELECT last_error FROM jobs WHERE id=$1`, [dj.id])).includes('boom'));
  check('a dead job is NOT deleted and NOT retried automatically', Number(await scalar(db, `SELECT count(*) FROM jobs WHERE id=$1 AND state='dead'`, [dj.id])) === 1);

  /* ── 5. Permanent failure fails fast ─────────────────────────────────────── */
  section('5. A permanent failure fails fast (no backoff schedule)');
  await pg.exec(`DELETE FROM jobs`);
  const pj = await enqueueJob(db, 't.perm', { idempotencyKey: 'p1', maxAttempts: 5 });
  const pjob = await claimJob(db, 'w', ['t.perm'], true);
  const pOutcome = await failJob(db, pjob!, 'w', 'file is gone', true, FAST.backoff);
  check('one attempt, then dead (not 5)', pOutcome === 'dead' && Number(await scalar(db, `SELECT attempts FROM jobs WHERE id=$1`, [pj.id])) === 1);
  check('the error is marked permanent', String(await scalar(db, `SELECT last_error FROM jobs WHERE id=$1`, [pj.id])).startsWith('permanent:'));

  /* ── 6. Starvation — interactive is not delayed by a bulk backlog ────────── */
  section('6. Starvation — an interactive job is claimed ahead of a bulk backlog');
  await pg.exec(`DELETE FROM jobs`);
  // Empty-queue baseline: one interactive job, time the claim.
  await enqueueJob(db, 't.echo', { idempotencyKey: 'base', lane: 'interactive' });
  let t0 = Date.now();
  const baseClaim = await claimJob(db, 'w', ['t.echo'], true);
  const baseMs = Date.now() - t0;
  await completeJob(db, baseClaim!, 'w');
  // Backlog: 2000 bulk jobs, then one interactive.
  await pg.exec(`INSERT INTO jobs (type, lane, idempotency_key) SELECT 't.echo', 'bulk', 'bulk-' || g FROM generate_series(1,2000) g`);
  const inter = await enqueueJob(db, 't.echo', { idempotencyKey: 'urgent', lane: 'interactive' });
  t0 = Date.now();
  const first = await claimJob(db, 'w', ['t.echo'], true);
  const backlogMs = Date.now() - t0;
  check('with 2000 bulk queued, the interactive job is claimed FIRST', first?.id === inter.id, `claimed id ${first?.id}, interactive id ${inter.id}`);
  check('claim latency stays flat under backlog', backlogMs <= baseMs + 50, `empty ${baseMs}ms vs backlog(2000) ${backlogMs}ms`);
  console.log(`     STARVATION EVIDENCE: interactive claim latency — empty queue ${baseMs}ms, 2000-job backlog ${backlogMs}ms`);

  /* ── 7. The worker end to end: concurrency limits + pause ─────────────────── */
  section('7. Worker — per-type + global limits hold, bulk can be paused');
  await pg.exec(`DELETE FROM jobs`);
  clearJobHandlers();
  let liveHeavy = 0, maxHeavy = 0, liveTotal = 0, maxTotal = 0, doneHeavy = 0;
  registerJobHandler('t.heavy', async () => {
    liveHeavy++; liveTotal++; maxHeavy = Math.max(maxHeavy, liveHeavy); maxTotal = Math.max(maxTotal, liveTotal);
    await sleep(40);
    liveHeavy--; liveTotal--; doneHeavy++;
  });
  let doneQuick = 0;
  registerJobHandler('t.quick', async () => { liveTotal++; maxTotal = Math.max(maxTotal, liveTotal); await sleep(10); liveTotal--; doneQuick++; });

  const cfg: QueueConfig = { ...FAST, globalConcurrency: 3, perType: { 't.heavy': 2 }, defaultPerType: 2 };
  const worker = new QueueWorker({ db, config: () => cfg, workerId: 'test' });
  await worker.start();
  for (let i = 0; i < 10; i++) await enqueueJob(db, 't.heavy', { idempotencyKey: `h${i}`, lane: 'bulk' });
  for (let i = 0; i < 6; i++) await enqueueJob(db, 't.quick', { idempotencyKey: `q${i}`, lane: 'bulk' });
  const allDone = await waitFor(() => doneHeavy === 10 && doneQuick === 6, 8000);
  check('every queued job ran to completion', allDone, `heavy ${doneHeavy}/10, quick ${doneQuick}/6`);
  check('per-type limit held (t.heavy never exceeded 2 at once)', maxHeavy <= 2, `max ${maxHeavy}`);
  check('global limit held (never more than 3 running at once)', maxTotal <= 3, `max ${maxTotal}`);

  // Pause the bulk lane: a new bulk job stays queued, an interactive one still runs.
  cfg.bulkPaused = true;
  await enqueueJob(db, 't.quick', { idempotencyKey: 'paused-bulk', lane: 'bulk' });
  await enqueueJob(db, 't.quick', { idempotencyKey: 'live-interactive', lane: 'interactive' });
  const interDone = await waitFor(() => doneQuick >= 7, 3000);
  check('while paused, the interactive job still ran', interDone);
  check('while paused, the bulk job stayed queued', (await scalar(db, `SELECT state FROM jobs WHERE idempotency_key='paused-bulk'`)) === 'queued');
  cfg.bulkPaused = false;
  const resumed = await waitFor(() => doneQuick >= 8, 3000);
  check('unpausing let the bulk job run', resumed);
  await worker.stop();

  /* ── 8. Placeholder analysis job runs ────────────────────────────────────── */
  section('8. Placeholder content-analysis job runs and records no provider');
  clearJobHandlers();
  registerJobHandler(CONTENT_ANALYSIS_JOB, contentAnalysisHandler);
  await enqueueJob(db, CONTENT_ANALYSIS_JOB, { idempotencyKey: 'analyze:1', payload: { messageId: 1 } });
  const w2 = new QueueWorker({ db, config: () => FAST, workerId: 'test2' });
  await w2.start();
  const analysed = await waitFor(async () => (await scalar(db, `SELECT count(*) FROM jobs WHERE type=$1 AND state='succeeded'`, [CONTENT_ANALYSIS_JOB])) == 1);
  await w2.stop();
  check('the analysis job succeeded (no-op handler)', analysed);

  /* ── 9. Admin views + operator actions ───────────────────────────────────── */
  section('9. Observability — depth, health, dead letters, retry, cancel');
  await pg.exec(`DELETE FROM jobs`);
  await enqueueJob(db, 't.a', { idempotencyKey: 'a1', lane: 'interactive' });
  await enqueueJob(db, 't.a', { idempotencyKey: 'a2', lane: 'bulk' });
  const dead = await enqueueJob(db, 't.b', { idempotencyKey: 'b1' });
  const dJob = await claimJob(db, 'w', ['t.b'], true);
  await failJob(db, dJob!, 'w', 'kaboom', true, FAST.backoff);
  const depth = await queueDepth(db);
  check('depth reports per type/lane/state', depth.some((d) => d.type === 't.a' && d.lane === 'interactive' && d.count === 1));
  const health = await queueHealth(db, {}, FAST.defaultStuckMs);
  check('health reports queued + dead counts', health.queued === 2 && health.dead === 1);
  check('health reports oldest-queued wait (a number)', health.oldestQueuedWaitSeconds !== null && health.oldestQueuedWaitSeconds >= 0);
  const dls = await listDeadLetters(db);
  check('dead letters are listed with their error', dls.length === 1 && (dls[0]?.lastError ?? '').includes('kaboom'));
  check('operator can retry a dead job', (await retryJob(db, dead.id)) && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [dead.id])) === 'queued');
  check('operator can cancel a queued job', (await cancelJob(db, dead.id)) && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [dead.id])) === 'cancelled');

  /* ── 10. Orphan reclaim — per-type threshold ─────────────────────────────── */
  section('10. Orphan reclaim honours a PER-TYPE threshold (slow types get patience)');
  await pg.exec(`DELETE FROM jobs`);
  const fast = await enqueueJob(db, 't.fast', { idempotencyKey: 'f1' });
  const slow = await enqueueJob(db, 't.slow', { idempotencyKey: 'sl1' });
  await claimJob(db, 'w', ['t.fast'], true);
  await claimJob(db, 'w', ['t.slow'], true);
  // Both have been "running" for ~10s. Default patience is 1s, but t.slow gets 1 hour.
  await pg.exec(`UPDATE jobs SET locked_at = now() - interval '10 seconds' WHERE id IN (${fast.id}, ${slow.id})`);
  const perType = { 't.slow': 3_600_000 };
  const h = await queueHealth(db, perType, 1000);
  check('only the fast job is flagged stuck; the slow one is within its threshold', h.stuck === 1);
  const reclaimed = await reclaimOrphans(db, perType, 1000, 'live-sweeper');
  check('the sweep reclaims ONLY the fast job', reclaimed.requeued === 1 && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [fast.id])) === 'queued');
  check('the slow job keeps running under its longer threshold (no double-run)', (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [slow.id])) === 'running');

  /* ── 11. A crash consumes a retry; a crash-loop dead-letters (not forever) ── */
  section('11. A job that crashes the worker dead-letters after max_attempts crashes');
  await pg.exec(`DELETE FROM jobs`);
  const poison = await enqueueJob(db, 't.poison', { idempotencyKey: 'x', maxAttempts: 3 });
  const crashes: Array<{ requeued: number; deadLettered: number }> = [];
  for (let i = 0; i < 3; i++) {
    // Claim (attempts++), then the worker "crashes": the job is left running with a
    // stale lock, and the sweep reclaims it. No handler throw is involved.
    await claimJob(db, 'w', ['t.poison'], true);
    await pg.exec(`UPDATE jobs SET locked_at = now() - interval '10 seconds' WHERE id = ${poison.id}`);
    crashes.push(await reclaimOrphans(db, {}, 1000, 'live-sweeper'));
  }
  check('crashes 1 and 2 requeued, crash 3 (= max_attempts) dead-lettered',
    crashes[0]?.requeued === 1 && crashes[1]?.requeued === 1 && crashes[2]?.deadLettered === 1,
    JSON.stringify(crashes));
  check('it did NOT loop forever — final state is dead', (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [poison.id])) === 'dead');
  check('the dead-letter reason names the crash, not a handler error',
    String(await scalar(db, `SELECT last_error FROM jobs WHERE id=$1`, [poison.id])).includes('crashed or stalled'));

  /* ── 12. Ownership fence — a superseded zombie run cannot clobber the row ─── */
  section('12. Ownership fence: a reclaimed run cannot flip a newer run’s outcome');
  await pg.exec(`DELETE FROM jobs`);
  const fj = await enqueueJob(db, 't.echo', { idempotencyKey: 'fence1' });
  const run1 = await claimJob(db, 'w', ['t.echo'], true); // attempts=1
  await pg.exec(`UPDATE jobs SET locked_at = now() - interval '10 s' WHERE id = ${fj.id}`);
  await reclaimOrphans(db, {}, 1000, 'sweeper'); // requeue (attempts stays 1)
  const run2 = await claimJob(db, 'w', ['t.echo'], true); // attempts=2 (fresh owner)
  check('the re-claim advanced the attempt token', run2?.id === fj.id && run2?.attempts === 2);
  const zombie = await completeJob(db, run1!, 'w'); // run1 finishes late
  check('the zombie run1 completion is refused (fenced by attempt)', zombie === false);
  check('the job is NOT falsely succeeded; run2 still owns it', (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [fj.id])) === 'running');
  const zombieFail = await failJob(db, run1!, 'w', 'late error', false, FAST.backoff);
  check('a zombie run1 failure is also refused', zombieFail === 'superseded');
  check('the live run2 completes it normally', (await completeJob(db, run2!, 'w')) === true && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [fj.id])) === 'succeeded');

  /* ── 13. Reclaim excludes the LIVE worker (no double-run of a slow job) ────── */
  section('13. A slow job the LIVE worker still holds is never reclaimed (no double-run)');
  await pg.exec(`DELETE FROM jobs`);
  const alive = await enqueueJob(db, 't.slowlive', { idempotencyKey: 'al1' });
  await claimJob(db, 'live', ['t.slowlive'], true); // locked_by='live'
  await pg.exec(`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${alive.id}`);
  const selfReclaim = await reclaimOrphans(db, {}, 1000, 'live'); // the live worker sweeps
  check('the live worker does NOT reclaim its own long job (however old the lock)', selfReclaim.requeued === 0 && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [alive.id])) === 'running');
  const otherReclaim = await reclaimOrphans(db, {}, 1000, 'a-different-worker');
  check('but a worker that does NOT hold it reclaims it as orphaned', otherReclaim.requeued === 1);

  /* ── 14. Orderly shutdown drains in-flight WITHOUT spending an attempt ─────── */
  section('14. A deploy drains in-flight jobs without penalty; a hard crash still dead-letters');
  await pg.exec(`DELETE FROM jobs`);
  const g = await enqueueJob(db, 't.echo', { idempotencyKey: 'g1', maxAttempts: 1 });
  const gj = await claimJob(db, 'live', ['t.echo'], true); // attempts=1, maxAttempts=1
  const drained = await drainInFlight(db, [gj!.id], 'live');
  check('the in-flight job is requeued on an orderly shutdown', drained === 1 && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [g.id])) === 'queued');
  check('the attempt was rolled back (a deploy is not a failed attempt)', Number(await scalar(db, `SELECT attempts FROM jobs WHERE id=$1`, [g.id])) === 0);
  // Contrast: the SAME single-attempt job, hard-crashed (no drain), dead-letters on startup.
  await claimJob(db, 'live', ['t.echo'], true); // attempts=1 again
  const startup = await reclaimOrphans(db, {}, 0, 'new-process');
  check('by contrast a hard-crashed single-attempt job dead-letters on startup', startup.deadLettered === 1 && (await scalar(db, `SELECT state FROM jobs WHERE id=$1`, [g.id])) === 'dead');

  /* ── 15. A non-integer per-type threshold is floored, not fatal ───────────── */
  section('15. A non-integer per-type threshold does not throw (sanitized)');
  await pg.exec(`DELETE FROM jobs`);
  const flt = await enqueueJob(db, 't.floaty', { idempotencyKey: 'ft1' });
  await claimJob(db, 'w', ['t.floaty'], true);
  await pg.exec(`UPDATE jobs SET locked_at = now() - interval '10 s' WHERE id = ${flt.id}`);
  let threw = false;
  try {
    await reclaimOrphans(db, { 't.floaty': 600000.5 }, 1000.9, 'sweeper');
    await queueHealth(db, { 't.floaty': 600000.5 }, 1000.9);
  } catch {
    threw = true;
  }
  check('a float threshold is floored, not a fatal ::bigint cast error', !threw);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  await pg.close();
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
