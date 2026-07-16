-- Cinderella consent gating — Season 0, Stage 3.
-- Consent is bound to the STABLE group member id, never the display name
-- (briefing §9). A member who leaves and rejoins gets a new member id, so
-- consent does not carry over — that is intended (fresh consent on rejoin).

CREATE TABLE consent (
  member_id    TEXT        PRIMARY KEY,
  -- Timestamp of the /publish command (a group-message timestamp, same clock
  -- domain as messages.sent_at) — publishing is forward-only from here.
  opted_in_at  TIMESTAMPTZ NOT NULL,
  -- Set by /unpublish; while non-null the member is opted out.
  revoked_at   TIMESTAMPTZ
);

-- Per-message publish state, derived from consent (never a stored flag, so it is
-- always consistent with the current consent set). A message is published only
-- when:
--   - it is not deleted (in-group deletions are honoured), AND
--   - its sender has a consent row that is not revoked, AND
--   - it was sent at/after that member's opt-in (forward-only).
CREATE VIEW message_publish_state AS
SELECT
  m.id,
  m.group_id,
  m.group_msg_id,
  m.sender_member_id,
  m.sent_at,
  (
    m.deleted = FALSE
    AND c.member_id IS NOT NULL
    AND c.revoked_at IS NULL
    AND m.sent_at >= c.opted_in_at
  ) AS published
FROM messages m
LEFT JOIN consent c ON c.member_id = m.sender_member_id;

-- The canonical "what appears on the public archive" projection (Season 1 web
-- front reads this).
CREATE VIEW published_messages AS
SELECT m.*
FROM messages m
JOIN message_publish_state s ON s.id = m.id
WHERE s.published;
