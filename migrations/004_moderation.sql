-- Cinderella admin views support — Season 0, Stage 5 (Addendum 1 / A3).

-- Failed file receipts are persisted so the dashboard can surface them before
-- the ~48h XFTP expiry (base briefing §10.2). NULL = no failure recorded.
ALTER TABLE messages ADD COLUMN media_error TEXT;

-- Fold manual takedown into the publish derivation: a message with
-- moderation_state = 'rejected' is never published, regardless of consent.
-- (Views are recreated rather than replaced so published_messages picks up the
-- new messages column.)
DROP VIEW published_messages;
DROP VIEW message_publish_state;

CREATE VIEW message_publish_state AS
SELECT
  m.id,
  m.group_id,
  m.group_msg_id,
  m.sender_member_id,
  m.sent_at,
  (
    m.deleted = FALSE
    AND m.moderation_state <> 'rejected'
    AND c.member_id IS NOT NULL
    AND c.revoked_at IS NULL
    AND m.sent_at >= c.opted_in_at
  ) AS published
FROM messages m
LEFT JOIN consent c ON c.member_id = m.sender_member_id;

CREATE VIEW published_messages AS
SELECT m.*
FROM messages m
JOIN message_publish_state s ON s.id = m.id
WHERE s.published;
