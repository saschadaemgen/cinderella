-- CCB-S3-022: a durable, PostgreSQL-backed job queue for background work.
--
-- The foundation the categorisation engine and the media gallery will run on.
-- Every prior piece of background work invented its own approach and failed in its
-- own invisible way: ad-hoc derivative generation that vanished images when a
-- directory was misowned, a one-off remediation script run as root, inline
-- thumbnail fetches, per-plugin retry logic. None survived a restart, none was
-- retryable, none was observable. This is the boring, durable replacement: work
-- survives a restart, retries with bounded exponential backoff, dead-letters
-- instead of vanishing or looping forever, and is claimed with FOR UPDATE SKIP
-- LOCKED so two workers can never double-run one job.

CREATE TYPE job_state AS ENUM ('queued', 'running', 'succeeded', 'dead', 'cancelled');

-- Coarse priority lane. The enum's declaration order IS the claim order:
-- 'interactive' sorts before 'bulk', so a member waiting for a reply is never
-- queued behind a thousand images being processed.
CREATE TYPE job_lane AS ENUM ('interactive', 'bulk');

CREATE TABLE jobs (
  id              BIGSERIAL   PRIMARY KEY,
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  state           job_state   NOT NULL DEFAULT 'queued',
  lane            job_lane    NOT NULL DEFAULT 'bulk',
  priority        INTEGER     NOT NULL DEFAULT 0,      -- higher first, within a lane
  attempts        INTEGER     NOT NULL DEFAULT 0,
  max_attempts    INTEGER     NOT NULL DEFAULT 5,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),  -- next scheduled time (backoff)
  idempotency_key TEXT        NOT NULL,
  last_error      TEXT,
  locked_at       TIMESTAMPTZ,                         -- when claimed; a stale value = crashed worker
  locked_by       TEXT,                                -- worker id, for stuck detection
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ                          -- set on succeeded / dead / cancelled
);

-- Idempotency: at most ONE live (queued or running) job per (type, key). Enqueuing
-- the same key while one is still live is a no-op that returns the existing id. A
-- terminal job does not block a later, deliberate re-enqueue of the same key, and
-- handlers are required to be idempotent so a repeat run is harmless either way.
CREATE UNIQUE INDEX jobs_idempotency_live
  ON jobs (type, idempotency_key)
  WHERE state IN ('queued', 'running');

-- The claim index: ordered exactly as the claim query scans it -- lane first, then
-- priority high-to-low, then oldest run_at, then id -- over only the claimable rows,
-- so finding the next job is cheap no matter how deep the backlog is.
CREATE INDEX jobs_claim
  ON jobs (lane, priority DESC, run_at, id)
  WHERE state = 'queued';

-- Observability: queue depth per state/type, and stuck (long-running) jobs.
CREATE INDEX jobs_state_type ON jobs (state, type);
CREATE INDEX jobs_running_locked ON jobs (locked_at) WHERE state = 'running';
