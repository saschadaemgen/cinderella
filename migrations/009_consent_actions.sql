-- Consent action journal (CCB-S3-002) — the record that makes UNDO possible.
--
-- The `consent` table holds the CURRENT decision, which is all the publish views
-- need. Undo needs one thing more: what the decision was immediately BEFORE the
-- last change, so it can be put back exactly. Deriving that from the current row
-- is impossible (an opt-in that replaced a revoked row and an opt-in that created
-- the first row leave identical state), so each change records its own previous
-- state here as it happens.
--
-- This is also the provenance trail for consent: every opt-in and opt-out now
-- says whether it arrived as a slash command, as natural language, or from the
-- admin console. The table is append-only — an undo marks the row it reverses
-- rather than deleting it, so the history stays readable.
--
-- It is NOT a second source of truth for publication. `message_publish_state`
-- continues to derive publication from `consent` alone.

CREATE TABLE consent_actions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id        TEXT        NOT NULL,
  -- What was done. Undo is recorded by stamping `undone_at` on the reversed row,
  -- not by writing an 'undo' action, so the journal reads as a list of decisions.
  action           TEXT        NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
  -- How it arrived: 'slash' (/publish), 'natural' (wake word), 'admin'.
  source           TEXT        NOT NULL CHECK (source IN ('slash', 'natural', 'admin')),
  -- Group-message timestamp of the triggering message (same clock domain as
  -- messages.sent_at and consent.opted_in_at), so undo windows compare like
  -- with like.
  at               TIMESTAMPTZ NOT NULL,
  -- The consent row as it stood BEFORE this action. prev_existed = FALSE means
  -- there was no row at all, so undoing this action deletes it again.
  prev_existed     BOOLEAN     NOT NULL,
  prev_opted_in_at TIMESTAMPTZ,
  prev_revoked_at  TIMESTAMPTZ,
  -- Set when this action has been reverted; a reverted action is never reverted twice.
  undone_at        TIMESTAMPTZ
);

-- Undo asks exactly one question: "the newest action by this member that has not
-- already been undone".
CREATE INDEX consent_actions_member_idx ON consent_actions (member_id, at DESC, id DESC);
