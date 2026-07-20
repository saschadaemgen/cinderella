-- Content reporting (CCB-S2-009) — public "Report" flagging + admin review queue.
--
-- A report is a legal-notice signal ("upon becoming aware of infringements, we
-- remove them immediately"), NOT a moderation action: it never changes a message's
-- publication state (visible-until-review). Only the operator's takedown removes
-- content. Rows store the minimum: which published item, why, when, and a
-- non-identifying per-item-per-day anti-abuse token (never a raw IP).

CREATE TYPE report_reason AS ENUM ('illegal', 'spam', 'copyright', 'other');
CREATE TYPE report_status AS ENUM ('open', 'resolved', 'dismissed');

CREATE TABLE reports (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id    BIGINT        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  reason        report_reason NOT NULL,
  note          TEXT,                        -- optional reporter text, app-capped to 1000 chars; NULL when omitted
  status        report_status NOT NULL DEFAULT 'open',
  reporter_hash TEXT          NOT NULL,       -- HMAC-SHA256(secret, ip|message_id|UTC-date); never a raw IP
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  handled_at    TIMESTAMPTZ,                  -- set when the operator resolves/dismisses/takes down
  handled_by    TEXT,                         -- operator username at the transition (mirrors audit_log.actor)
  -- DB-level dedup/debounce: one row per (item, client, day). Repeat reports are
  -- absorbed by INSERT ... ON CONFLICT DO NOTHING; the daily-rotating hash still
  -- lets a genuine re-report happen the next day.
  CONSTRAINT reports_dedup UNIQUE (message_id, reporter_hash)
);

-- Hot path for the notification bar (distinct open messages) + the queue.
CREATE INDEX reports_open_idx    ON reports (message_id) WHERE status = 'open';
-- Per-message grouping for the queue (all statuses).
CREATE INDEX reports_message_idx ON reports (message_id);
