/**
 * CCB-S3-024 verification harness — the capture write-ahead log (Slice 1).
 *
 * Runs the REAL migration and the REAL store + replay engine against PGlite
 * (Postgres in WASM), proving the durability substrate before the dispatcher is
 * wired to it (Slice 2):
 *   - the write-ahead is idempotent: a redelivered event records once,
 *   - an applied event becomes processed; marking processed is idempotent,
 *   - a transient failure retries and then dead-letters, keeping the event,
 *   - a permanent failure dead-letters at once without burning the schedule,
 *   - an early deletion is deferred and then applied once its message arrives
 *     (out-of-order delivery), and a failed insert never lets its edit apply
 *     ahead of it (per-conversation ordering),
 *   - counts and the dead-letter count are reported for the admin diagnostics,
 *   - retention prunes ONLY processed rows, never pending/deferred/dead,
 *   - the real queue worker drains the backlog via the registered job.
 *
 *   npx tsx scripts/verify-capture-events.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { loadMigrationFiles } from '../src/db/migrate.js';
import type { Queryable } from '../src/db/pool.js';
import {
  captureEventCounts,
  deadCaptureEventCount,
  deferEvent,
  failEvent,
  markEventProcessed,
  nextDrainBatch,
  pruneProcessedEvents,
  recordEvent,
  type CaptureEventRow,
} from '../src/capture/events/store.js';
import {
  CAPTURE_DRAIN_JOB,
  clearCaptureReprocessors,
  drainCaptureEvents,
  processEvent,
  registerCaptureReprocessor,
} from '../src/capture/events/replay.js';
import { PermanentJobError, type QueueConfig } from '../src/queue/types.js';
import { clearJobHandlers, getJobHandler, registerJobHandler } from '../src/queue/registry.js';
import { enqueueJob } from '../src/queue/store.js';
import { QueueWorker } from '../src/queue/worker.js';
import { registerBuiltinJobs } from '../src/queue/index.js';

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

async function scalar(db: Queryable, sql: string, params: unknown[] = []): Promise<unknown> {
  const { rows } = await db.query<Record<string, unknown>>(sql, params);
  const r = rows[0];
  return r ? Object.values(r)[0] : undefined;
}

async function stateOf(db: Queryable, id: number): Promise<string | undefined> {
  return (await scalar(db, `SELECT state FROM capture_events WHERE id = $1`, [id])) as string | undefined;
}
async function attemptsOf(db: Queryable, id: number): Promise<number> {
  return Number(await scalar(db, `SELECT attempts FROM capture_events WHERE id = $1`, [id]));
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

async function main(): Promise<void> {
  const pg = new PGlite();
  const db: Queryable = {
    async query(text, values) {
      const res = await pg.query(text, values ? [...values] : undefined);
      return { rows: res.rows as never[], rowCount: (res.affectedRows ?? res.rows.length) as number };
    },
  };
  for (const m of await loadMigrationFiles()) await pg.exec(m.sql);

  // ── §1 the write-ahead is idempotent ──────────────────────────────────────
  section('§1 write-ahead records each event exactly once');
  {
    const first = await recordEvent(db, {
      kind: 'new_message',
      conversationKey: '7',
      dedupeKey: 'msg:1001',
      payload: { itemId: 1001, text: 'hi' },
    });
    const again = await recordEvent(db, {
      kind: 'new_message',
      conversationKey: '7',
      dedupeKey: 'msg:1001',
      payload: { itemId: 1001, text: 'hi' },
    });
    check('first record creates a row', first.created && first.state === 'pending', `id ${first.id}`);
    check('redelivery does NOT create a second row', !again.created && again.id === first.id);
    const n = Number(await scalar(db, `SELECT count(*) FROM capture_events WHERE dedupe_key = 'msg:1001'`));
    check('exactly one row exists for the dedupe key', n === 1, `rows=${n}`);
  }

  // ── §2 apply → processed, idempotent ──────────────────────────────────────
  section('§2 an applied event becomes processed; marking is idempotent');
  {
    clearCaptureReprocessors();
    registerCaptureReprocessor('new_message', async () => 'applied');
    const rec = await recordEvent(db, {
      kind: 'new_message',
      conversationKey: '7',
      dedupeKey: 'msg:1002',
      payload: { itemId: 1002 },
    });
    const row: CaptureEventRow = { id: rec.id, kind: 'new_message', conversationKey: '7', payload: {}, attempts: 0, maxAttempts: 10 };
    const outcome = await processEvent(db, row);
    check('processEvent returns applied', outcome === 'applied');
    check('row is processed', (await stateOf(db, rec.id)) === 'processed');
    const processedAt = await scalar(db, `SELECT processed_at IS NOT NULL FROM capture_events WHERE id = $1`, [rec.id]);
    check('processed_at is set', processedAt === true);
    await markEventProcessed(db, rec.id);
    check('marking an already-processed row again is a no-op', (await stateOf(db, rec.id)) === 'processed');
  }

  // ── §3 transient failure retries, then dead-letters ───────────────────────
  section('§3 a transient failure retries and then dead-letters, keeping the event');
  {
    clearCaptureReprocessors();
    registerCaptureReprocessor('new_message', async () => {
      throw new Error('db blip');
    });
    const rec = await recordEvent(db, {
      kind: 'new_message',
      conversationKey: '7',
      dedupeKey: 'msg:1003',
      payload: { itemId: 1003 },
      maxAttempts: 2,
    });
    const row: CaptureEventRow = { id: rec.id, kind: 'new_message', conversationKey: '7', payload: {}, attempts: 0, maxAttempts: 2 };
    const o1 = await processEvent(db, row);
    check('first failure keeps the event pending', o1 === 'failed' && (await stateOf(db, rec.id)) === 'pending', `attempts=${await attemptsOf(db, rec.id)}`);
    const o2 = await processEvent(db, row);
    check('last attempt dead-letters (never dropped)', o2 === 'dead' && (await stateOf(db, rec.id)) === 'dead');
    const err = (await scalar(db, `SELECT last_error FROM capture_events WHERE id = $1`, [rec.id])) as string;
    check('the failure reason is kept', /blip/.test(err), err);
  }

  // ── §4 permanent failure dead-letters at once ─────────────────────────────
  section('§4 a permanent failure dead-letters immediately, not after the whole schedule');
  {
    clearCaptureReprocessors();
    registerCaptureReprocessor('new_message', async () => {
      throw new PermanentJobError('payload can never be a message');
    });
    const rec = await recordEvent(db, {
      kind: 'new_message',
      conversationKey: '7',
      dedupeKey: 'msg:1004',
      payload: { itemId: 1004 },
      maxAttempts: 10,
    });
    const row: CaptureEventRow = { id: rec.id, kind: 'new_message', conversationKey: '7', payload: {}, attempts: 0, maxAttempts: 10 };
    const o = await processEvent(db, row);
    check('permanent failure is dead immediately', o === 'dead' && (await stateOf(db, rec.id)) === 'dead');
    check('it did NOT burn the whole attempt budget', (await attemptsOf(db, rec.id)) === 1, `attempts=${await attemptsOf(db, rec.id)}`);
    const err = (await scalar(db, `SELECT last_error FROM capture_events WHERE id = $1`, [rec.id])) as string;
    check('marked as permanent for the operator', /^permanent:/.test(err), err);
  }

  // ── §5 defer + ordering ───────────────────────────────────────────────────
  // Isolate this section so ordering is deterministic (drainCaptureEvents runs to
  // completion, so other conversations' progress would otherwise interleave).
  section('§5 ordering: a broken insert never lets its edit apply ahead; an out-of-order deletion waits for its message');
  {
    await pg.exec(`DELETE FROM capture_events`);
    clearCaptureReprocessors();
    const captured = new Set<number>();
    const applyLog: string[] = [];
    registerCaptureReprocessor('new_message', async (_db, e) => {
      const id = Number((e.payload as { itemId: number }).itemId);
      if (id === 20) throw new Error('insert 20 is broken'); // never applies
      captured.add(id);
      applyLog.push(`insert:${id}`);
      return 'applied';
    });
    registerCaptureReprocessor('edit', async (_db, e) => {
      const id = Number((e.payload as { itemId: number }).itemId);
      if (!captured.has(id)) return 'deferred'; // an edit before its message: wait
      applyLog.push(`edit:${id}`);
      return 'applied';
    });
    registerCaptureReprocessor('deletion', async (_db, e) => {
      const id = Number((e.payload as { itemId: number }).itemId);
      if (!captured.has(id)) return 'deferred'; // an early deletion: wait for the message
      captured.delete(id);
      applyLog.push(`del:${id}`);
      return 'applied';
    });

    // (a) A broken insert (item 20) and its edit, same conversation. The edit must
    // never be applied ahead of the insert it depends on, even as the insert fails
    // and dead-letters.
    const ins = await recordEvent(db, { kind: 'new_message', conversationKey: 'A', dedupeKey: 'A:msg:20', payload: { itemId: 20 }, maxAttempts: 2 });
    await recordEvent(db, { kind: 'edit', conversationKey: 'A', dedupeKey: 'A:edit:20', payload: { itemId: 20 }, maxAttempts: 3 });
    for (let i = 0; i < 8; i++) await drainCaptureEvents(db);
    check('a broken insert never lets its edit apply ahead of it', !applyLog.includes('edit:20'), applyLog.join(' '));
    check('the broken insert dead-lettered (kept for the operator, not dropped)', (await stateOf(db, ins.id)) === 'dead');

    // (b) Out-of-order delivery: the deletion of item 30 is RECORDED before its
    // insert (lower id = earlier arrival). It defers until the message lands, then
    // applies — never before.
    await recordEvent(db, { kind: 'deletion', conversationKey: 'B', dedupeKey: 'B:del:30', payload: { itemId: 30 } });
    await recordEvent(db, { kind: 'new_message', conversationKey: 'B', dedupeKey: 'B:msg:30', payload: { itemId: 30 } });
    for (let i = 0; i < 4; i++) await drainCaptureEvents(db);
    check(
      'the out-of-order deletion applied only after its message arrived',
      applyLog.includes('insert:30') &&
        applyLog.includes('del:30') &&
        applyLog.indexOf('insert:30') < applyLog.indexOf('del:30'),
      applyLog.join(' '),
    );
    const unfinishedB = Number(await scalar(db, `SELECT count(*) FROM capture_events WHERE conversation_key='B' AND state IN ('pending','deferred')`));
    check('conversation B fully settled', unfinishedB === 0, `unfinished=${unfinishedB}`);
  }

  // ── §6 defer bound: a deletion whose message never comes eventually dead-letters ─
  section('§6 a deferral that never resolves is bounded (dead-lettered, not retried forever)');
  {
    const rec = await recordEvent(db, { kind: 'deletion', conversationKey: 'C', dedupeKey: 'C:del:999', payload: { itemId: 999 }, maxAttempts: 3 });
    let last = 'deferred';
    for (let i = 0; i < 3; i++) last = await deferEvent(db, rec.id, 'no matching message');
    check('an unresolved defer is bounded and dead-letters', last === 'dead' && (await stateOf(db, rec.id)) === 'dead');
  }

  // ── §7 counts for the admin diagnostics ───────────────────────────────────
  section('§7 per-kind/state counts and the dead-letter count are reported');
  {
    const counts = await captureEventCounts(db);
    const has = (k: string, s: string): boolean => counts.some((c) => c.kind === k && c.state === s && c.count > 0);
    check('processed new messages are counted', has('new_message', 'processed'));
    check('dead events are counted', has('new_message', 'dead'));
    const dead = await deadCaptureEventCount(db);
    check('the dead-letter count is a positive integer', dead >= 2, `dead=${dead}`);
    const retried = counts.some((c) => c.retries > 0);
    check('retry load is surfaced', retried);
  }

  // ── §8 retention prunes processed rows only ───────────────────────────────
  section('§8 retention prunes ONLY processed rows, never pending/deferred/dead');
  {
    // Age every processed row well past the window.
    await db.query(`UPDATE capture_events SET processed_at = now() - interval '30 days' WHERE state = 'processed'`);
    const deadBefore = await deadCaptureEventCount(db);
    const pendingBefore = Number(await scalar(db, `SELECT count(*) FROM capture_events WHERE state IN ('pending','deferred')`));
    const removed = await pruneProcessedEvents(db, 7 * 24 * 60 * 60 * 1000);
    const processedAfter = Number(await scalar(db, `SELECT count(*) FROM capture_events WHERE state = 'processed'`));
    const deadAfter = await deadCaptureEventCount(db);
    const pendingAfter = Number(await scalar(db, `SELECT count(*) FROM capture_events WHERE state IN ('pending','deferred')`));
    check('processed rows past the window were pruned', removed > 0 && processedAfter === 0, `removed=${removed}`);
    check('dead rows were NOT pruned (forensic)', deadAfter === deadBefore && deadBefore > 0);
    check('pending/deferred rows were NOT pruned', pendingAfter === pendingBefore);
    // A recent processed row must survive.
    clearCaptureReprocessors();
    registerCaptureReprocessor('new_message', async () => 'applied');
    const recent = await recordEvent(db, { kind: 'new_message', conversationKey: '7', dedupeKey: 'msg:recent', payload: {} });
    await processEvent(db, { id: recent.id, kind: 'new_message', conversationKey: '7', payload: {}, attempts: 0, maxAttempts: 10 });
    const removed2 = await pruneProcessedEvents(db, 7 * 24 * 60 * 60 * 1000);
    check('a freshly processed row is kept (inside the window)', removed2 === 0 && (await stateOf(db, recent.id)) === 'processed');
  }

  // ── §9 the real queue worker drains via the registered job ────────────────
  section('§9 the registered capture.drain job drains the backlog through the real worker');
  {
    // The shipped wiring registers the drain handler on the real registry.
    clearJobHandlers();
    registerBuiltinJobs();
    check('registerBuiltinJobs() wires the capture.drain handler', getJobHandler(CAPTURE_DRAIN_JOB) !== undefined);

    clearCaptureReprocessors();
    const done = new Set<number>();
    registerCaptureReprocessor('new_message', async (_db, e) => {
      done.add(Number((e.payload as { itemId: number }).itemId));
      return 'applied';
    });
    // Two fresh pending events, no inline processing — only the drain will apply them.
    await recordEvent(db, { kind: 'new_message', conversationKey: '11', dedupeKey: 'msg:5001', payload: { itemId: 5001 } });
    await recordEvent(db, { kind: 'new_message', conversationKey: '11', dedupeKey: 'msg:5002', payload: { itemId: 5002 } });

    // The shipped captureDrainHandler wraps drainCaptureEvents(getPool()); the
    // harness has no real pool, so the worker runs a handler closed over the PGlite
    // db. This proves the queue integration (interactive lane, claim, run, drain).
    clearJobHandlers();
    registerJobHandler(CAPTURE_DRAIN_JOB, async (_p, ctx) => {
      await drainCaptureEvents(db, () => ctx.stopping());
    });
    const worker = new QueueWorker({ db, config: () => FAST });
    await worker.start();
    const enq = await enqueueJob(db, CAPTURE_DRAIN_JOB, { idempotencyKey: 'capture.drain', lane: 'interactive' });
    check('drain job enqueued on the interactive lane', enq.created);
    const ok = await waitFor(async () => {
      const n = Number(await scalar(db, `SELECT count(*) FROM capture_events WHERE conversation_key='11' AND state='pending'`));
      return n === 0;
    });
    check('the worker drained both recorded events', ok && done.has(5001) && done.has(5002));
    await worker.stop();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  await pg.close();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
