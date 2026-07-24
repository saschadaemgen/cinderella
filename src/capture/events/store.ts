/**
 * Capture write-ahead log — the SQL (CCB-S3-024). This is the only module that
 * touches the `capture_events` table.
 *
 * Every capture event the running bot sees is recorded here BEFORE it is applied
 * to the archive, and marked processed only once it has been applied. A process
 * that fails leaves a durable row the drain retries, rather than a message lost to
 * a log line. Idempotency is structural: the write-ahead dedupes on `dedupe_key`,
 * and every state transition below is safe to run twice.
 */

import type { Queryable } from '../../db/pool.js';

/** The three events the running bot subscribes to (handler.ts). */
export type CaptureEventKind = 'new_message' | 'edit' | 'deletion';

export type CaptureEventState = 'pending' | 'processed' | 'deferred' | 'dead';

/** A recorded event as the drain re-applies it. */
export interface CaptureEventRow {
  id: number;
  kind: CaptureEventKind;
  conversationKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface RecordEventInput {
  kind: CaptureEventKind;
  /** The ordering domain — the group id as text. Per-conversation order is preserved on replay. */
  conversationKey: string;
  /** Makes the write-ahead idempotent: a redelivered event records once. */
  dedupeKey: string;
  payload: Record<string, unknown>;
  /** Optional override; defaults to the column default (10). */
  maxAttempts?: number;
}

interface RowShape {
  id: string;
  kind: CaptureEventKind;
  conversation_key: string;
  payload: Record<string, unknown> | null;
  attempts: string | number;
  max_attempts: string | number;
}

function toRow(r: RowShape): CaptureEventRow {
  return {
    id: Number(r.id),
    kind: r.kind,
    conversationKey: r.conversation_key,
    payload: r.payload ?? {},
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  };
}

/**
 * Records a raw capture event, idempotently. A redelivered event (same
 * `dedupe_key`) does NOT insert a second row — it returns the existing row's id
 * and state with `created:false`, so the caller can skip an already-processed
 * event rather than applying it twice.
 */
export async function recordEvent(
  db: Queryable,
  input: RecordEventInput,
): Promise<{ id: number; state: CaptureEventState; created: boolean }> {
  const inserted = await db.query<{ id: string; state: CaptureEventState }>(
    `INSERT INTO capture_events (kind, conversation_key, dedupe_key, payload, max_attempts)
     VALUES ($1::capture_event_kind, $2, $3, $4::jsonb, COALESCE($5, 10))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id, state`,
    [input.kind, input.conversationKey, input.dedupeKey, JSON.stringify(input.payload), input.maxAttempts ?? null],
  );
  if (inserted.rows[0]) {
    return { id: Number(inserted.rows[0].id), state: inserted.rows[0].state, created: true };
  }
  const existing = await db.query<{ id: string; state: CaptureEventState }>(
    `SELECT id, state FROM capture_events WHERE dedupe_key = $1`,
    [input.dedupeKey],
  );
  const row = existing.rows[0];
  return { id: Number(row?.id ?? 0), state: row?.state ?? 'pending', created: false };
}

/** Marks an event applied. Idempotent — a second call on a processed row is a no-op. */
export async function markEventProcessed(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE capture_events
        SET state = 'processed', processed_at = now(), updated_at = now(), last_error = NULL
      WHERE id = $1 AND state <> 'processed'`,
    [id],
  );
}

/**
 * Records a transient failure. The event stays `pending` (retried on the next
 * drain) unless it has now exhausted its attempts, in which case it is
 * DEAD-LETTERED — kept for the operator as a lost member event, never dropped.
 * Returns the resulting state.
 */
export async function failEvent(
  db: Queryable,
  id: number,
  error: string,
): Promise<'pending' | 'dead'> {
  const { rows } = await db.query<{ state: 'pending' | 'dead' }>(
    `UPDATE capture_events
        SET attempts = attempts + 1,
            state = (CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'pending' END)::capture_event_state,
            last_error = $2,
            processed_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE processed_at END,
            updated_at = now()
      WHERE id = $1 AND state IN ('pending', 'deferred')
      RETURNING state`,
    [id, error.slice(0, 2000)],
  );
  return rows[0]?.state ?? 'dead';
}

/**
 * Records that an event cannot be applied yet because its target has not arrived
 * (an early deletion for a not-yet-captured message). Held as `deferred` and
 * retried, until either its target appears or it exhausts its attempts and
 * dead-letters with a benign reason (a deletion whose message we never had hid
 * nothing, so an exhausted defer is not a leak). Returns the resulting state.
 */
export async function deferEvent(
  db: Queryable,
  id: number,
  reason: string,
): Promise<'deferred' | 'dead'> {
  const { rows } = await db.query<{ state: 'deferred' | 'dead' }>(
    `UPDATE capture_events
        SET attempts = attempts + 1,
            state = (CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'deferred' END)::capture_event_state,
            last_error = $2,
            processed_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE processed_at END,
            updated_at = now()
      WHERE id = $1 AND state IN ('pending', 'deferred')
      RETURNING state`,
    [id, reason.slice(0, 2000)],
  );
  return rows[0]?.state ?? 'dead';
}

/**
 * Dead-letters an event immediately, without consuming its remaining attempts.
 * For a PERMANENT failure — a payload that can never become a valid message — so
 * it does not spin through the whole retry schedule first (mirrors the queue's
 * PermanentJobError). Kept for the operator, never pruned.
 */
export async function deadLetterEvent(db: Queryable, id: number, reason: string): Promise<void> {
  await db.query(
    `UPDATE capture_events
        SET state = 'dead', last_error = $2, processed_at = now(), updated_at = now(),
            attempts = attempts + 1
      WHERE id = $1 AND state IN ('pending', 'deferred')`,
    [id, `permanent: ${reason}`.slice(0, 2000)],
  );
}

/**
 * The unfinished events in ARRIVAL ORDER (id ascending). Both pending and
 * deferred, so a deferred early deletion is retried once its message lands. The
 * drain replays these in order; ordering the query by id is what preserves
 * per-conversation order on replay (CCB-S3-024 §4).
 */
export async function nextDrainBatch(db: Queryable, limit = 500): Promise<CaptureEventRow[]> {
  const { rows } = await db.query<RowShape>(
    `SELECT id, kind, conversation_key, payload, attempts, max_attempts
       FROM capture_events
      WHERE state IN ('pending', 'deferred')
      ORDER BY id
      LIMIT $1`,
    [limit],
  );
  return rows.map(toRow);
}

/** True while any event still needs work — used to decide whether to keep draining. */
export async function hasUnfinishedEvents(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM capture_events WHERE state IN ('pending', 'deferred') LIMIT 1`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/* ── Observability + retention (CCB-S3-024 §5, §6) ───────────────────────── */

export interface CaptureEventCount {
  kind: CaptureEventKind;
  state: CaptureEventState;
  count: number;
  /** Sum of retry attempts across the rows in this bucket. */
  retries: number;
}

/**
 * Per-kind, per-state counts for the admin diagnostics. `received` is the row
 * total per kind (sum across states); `retries` surfaces how much work is being
 * re-attempted. Healthy = only `processed` rows and zero retries, which the admin
 * page renders as nothing (CCB-S3-023: no noise when nothing is wrong).
 */
export async function captureEventCounts(db: Queryable): Promise<CaptureEventCount[]> {
  const { rows } = await db.query<{ kind: CaptureEventKind; state: CaptureEventState; n: string; r: string }>(
    `SELECT kind::text AS kind, state::text AS state, count(*)::int AS n,
            COALESCE(sum(attempts), 0)::int AS r
       FROM capture_events
      GROUP BY kind, state
      ORDER BY kind, state`,
  );
  return rows.map((r) => ({ kind: r.kind, state: r.state, count: Number(r.n), retries: Number(r.r) }));
}

/** Count of dead-lettered capture events — a lost member event needing attention. */
export async function deadCaptureEventCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM capture_events WHERE state = 'dead'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Prunes PROCESSED events older than the window. Never touches pending, deferred,
 * or dead rows: unfinished work and lost events are forensic evidence, not
 * clutter. Raw events hold member content, so the default window is short
 * (CCB-S3-024 §5). Returns the number of rows removed.
 */
export async function pruneProcessedEvents(db: Queryable, olderThanMs: number): Promise<number> {
  const ms = Math.max(0, Math.floor(olderThanMs));
  const { rowCount } = await db.query(
    `DELETE FROM capture_events
      WHERE state = 'processed'
        AND processed_at IS NOT NULL
        AND processed_at < now() - ($1 || ' milliseconds')::interval`,
    [String(ms)],
  );
  return rowCount ?? 0;
}
