-- Cinderella deletion provenance — Season 0 review fix.
--
-- Problem: `deleted` was set both by in-group deletion events AND by the admin
-- "mark deleted" action, and admin "undelete" cleared it — so an operator could
-- undelete (and thus RE-PUBLISH) a message a member had deleted in the group,
-- violating "deleted/disappearing messages are never published" (§5).
--
-- Fix: split the two sources. `group_deleted` is set ONLY by in-group deletion
-- events and is never clearable from the admin console; `deleted` is the
-- admin-initiated flag. The publish views exclude either. Undelete only clears
-- `deleted`, so a group deletion can never be undone into publication.

ALTER TABLE messages ADD COLUMN group_deleted BOOLEAN NOT NULL DEFAULT FALSE;

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
    AND m.group_deleted = FALSE
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
