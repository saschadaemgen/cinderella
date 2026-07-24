-- CCB-S3-024: a write-ahead log for capture events.
--
-- SimpleX delivers each event ONCE and never re-sends it. Before this, a new
-- message or an edit was persisted through a single try/catch that logged and
-- dropped on failure (src/capture/handler.ts): a DB blip lost that member's
-- message forever, with only a log line, and the 16 unrecoverable file receipts
-- of CCB-S3-018 are the same shape. This table is the durable record written
-- BEFORE the message is processed, so a failed process leaves a row to retry
-- instead of a gap. The scope gate (CCB-S3-019, isPublicGroupChat) runs BEFORE
-- the write, so support-scope and direct events never land here.

-- The three capture events the RUNNING bot subscribes to. Member/profile events
-- live only in the one-shot connect helper and are deliberately absent.
CREATE TYPE capture_event_kind AS ENUM ('new_message', 'edit', 'deletion');

-- pending   : recorded, not yet applied (or a transient failure to retry).
-- processed : applied to the archive successfully; prunable after the window.
-- deferred  : its target has not arrived yet (an early deletion for a message we
--             have not captured); held and retried, never dropped.
-- dead      : exhausted its attempts; kept for the operator, never pruned. A
--             dead capture event is a lost member event and is surfaced apart
--             from an ordinary job failure (CCB-S3-024 §6).
CREATE TYPE capture_event_state AS ENUM ('pending', 'processed', 'deferred', 'dead');

CREATE TABLE capture_events (
  id               BIGSERIAL           PRIMARY KEY,     -- also the replay order: rows are inserted in arrival order
  kind             capture_event_kind  NOT NULL,
  conversation_key TEXT                NOT NULL,         -- the ordering domain (the group id, as text)
  dedupe_key       TEXT                NOT NULL,         -- makes the write-ahead itself idempotent
  payload          JSONB               NOT NULL,         -- everything needed to re-apply the event
  state            capture_event_state NOT NULL DEFAULT 'pending',
  attempts         INTEGER             NOT NULL DEFAULT 0,
  max_attempts     INTEGER             NOT NULL DEFAULT 10, -- more patient than a job: losing a member event is worse
  last_error       TEXT,
  received_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,                          -- set on processed / dead (the prune + retention anchor)
  updated_at       TIMESTAMPTZ         NOT NULL DEFAULT now()
);

-- The write-ahead is idempotent: a redelivered event (same kind + item) records
-- once. A genuinely new event (a second, later edit of the same message) carries
-- a different dedupe_key and records as its own row.
CREATE UNIQUE INDEX capture_events_dedupe ON capture_events (dedupe_key);

-- The drain scans the unfinished rows in arrival order (id). Partial, so it stays
-- cheap no matter how many processed rows have accumulated.
CREATE INDEX capture_events_drain
  ON capture_events (id)
  WHERE state IN ('pending', 'deferred');

-- Per-kind/state counts for the admin diagnostics (CCB-S3-024 §6).
CREATE INDEX capture_events_state_kind ON capture_events (state, kind);

-- Retention prunes processed rows by age; never touches pending/deferred/dead.
CREATE INDEX capture_events_processed_at
  ON capture_events (processed_at)
  WHERE state = 'processed';
