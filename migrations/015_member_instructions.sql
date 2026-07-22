-- Member questions belong in the archive (CCB-S3-009).
--
-- WHY THIS EXISTS: the capture path dropped any message the interaction layer
-- consumed. That was right when an instruction meant `/publish` — plumbing, not
-- conversation. Since natural addressing (CCB-S3-002) it meant every question a
-- member asked her was silently discarded, so the public archive showed her
-- answers with nothing above them. She appeared to be answering nobody, at
-- exactly the points where the conversation was most worth reading.
--
-- A member's instruction is still that member's message. Consent decides whether
-- it publishes; being addressed to a bot does not remove it from the record.
--
-- Two columns and one rule:
--
--   member_category  what KIND of instruction it was, NULL for ordinary chat.
--   reply_to_id      on one of HER rows, the member message that triggered it.
--
-- And the rule: QUESTION AND ANSWER ARE A PAIR. An answer whose question is not
-- published is not published either. Publishing half an exchange misrepresents
-- what happened, and the half that survives is hers — which reads as her talking
-- about a member who chose not to be quoted.

-- NULL means ordinary conversation, which publishes on the plain consent rules.
-- Note the asymmetry with `bot_category`, and that it is deliberate: an
-- unclassified message of HERS is excluded, an unclassified message of a
-- MEMBER'S is published. Her words need a reason to be public; an opted-in
-- member's words need a reason not to be.
ALTER TABLE messages ADD COLUMN member_category TEXT;

-- Set on her rows only. Self-referential, so the pair survives as one object:
-- deleting the question takes the answer with it rather than orphaning it.
ALTER TABLE messages ADD COLUMN reply_to_id BIGINT REFERENCES messages (id) ON DELETE CASCADE;

CREATE INDEX messages_reply_to_idx ON messages (reply_to_id);

/* ── Which member instructions publish ───────────────────────────────────── */

DROP VIEW published_messages;
DROP VIEW message_publish_state;

CREATE VIEW member_publish_settings AS
SELECT
  -- Same shape and the same throw-proof comparison as bot_publish_settings: a
  -- cast can RAISE, and a raise inside this view takes every public read with it.
  '{"price": true, "search": true, "status": true, "help": true,
    "consent": false, "confirmation": false, "nickname": false,
    "disambiguation": false}'::jsonb
    || CASE
         WHEN jsonb_typeof(v -> 'memberCategories') = 'object' THEN v -> 'memberCategories'
         ELSE '{}'::jsonb
       END AS categories
FROM (SELECT (SELECT value FROM settings WHERE key = 'archive') AS v) t;

/* ── The derivation, now covering both halves of an exchange ─────────────── */

CREATE VIEW message_publish_state AS
WITH base AS (
  SELECT
    m.id,
    m.group_id,
    m.group_msg_id,
    m.sender_member_id,
    m.sent_at,
    m.is_bot,
    m.reply_to_id,
    (
      m.deleted = FALSE
      AND m.group_deleted = FALSE
      AND m.moderation_state <> 'rejected'
      AND CASE
        WHEN m.is_bot THEN
          b.publish_bot
          AND m.bot_category IS NOT NULL
          AND b.categories -> m.bot_category = 'true'::jsonb
          AND m.mentions_scanned
          AND (b.mention_guard <> 'withhold' OR NOT EXISTS (
                SELECT 1
                FROM message_mentions mm
                LEFT JOIN consent mc ON mc.member_id = mm.member_id
                WHERE mm.message_id = m.id
                  AND (mm.member_id IS NULL OR mc.member_id IS NULL OR mc.revoked_at IS NOT NULL)
              ))
        ELSE
          c.member_id IS NOT NULL
          AND c.revoked_at IS NULL
          AND m.sent_at >= c.opted_in_at
          -- An instruction publishes unless its category is switched off. NULL —
          -- ordinary chat — is unaffected.
          AND (
            m.member_category IS NULL
            OR mp.categories -> m.member_category = 'true'::jsonb
          )
      END
    ) AS self_published
  FROM messages m
  LEFT JOIN consent c ON c.member_id = m.sender_member_id
  CROSS JOIN bot_publish_settings b
  CROSS JOIN member_publish_settings mp
)
SELECT
  base.id,
  base.group_id,
  base.group_msg_id,
  base.sender_member_id,
  base.sent_at,
  (
    base.self_published
    -- PAIR COHERENCE. One of her replies publishes only if the question it
    -- answers does. Derived, not stored, so a member's later /unpublish removes
    -- both halves on the next read with no backfill anywhere.
    AND (
      base.reply_to_id IS NULL
      OR EXISTS (SELECT 1 FROM base q WHERE q.id = base.reply_to_id AND q.self_published)
    )
  ) AS published
FROM base;

CREATE VIEW published_messages AS
SELECT
  m.id,
  m.group_id,
  m.group_msg_id,
  m.shared_msg_id,
  m.sender_member_id,
  m.sender_display_name,
  m.sent_at,
  m.type,
  CASE
    WHEN m.is_bot AND r.pattern IS NOT NULL AND m.text_body IS NOT NULL
      THEN regexp_replace(
             m.text_body,
             r.pattern,
             replace(
               COALESCE(
                 pj.persona -> m.bot_lang ->> 'redactedMember',
                 pj.persona -> 'en' ->> 'redactedMember',
                 'that member'
               ),
               '\', '\\'
             ),
             'g'
           )
    ELSE m.text_body
  END AS text_body,
  m.links_text,
  m.media_path,
  m.media_mime,
  m.media_size,
  m.media_derived_path,
  m.media_strip_skipped,
  m.deleted,
  m.group_deleted,
  m.moderation_state,
  m.media_error,
  m.captured_at,
  m.is_bot,
  m.bot_category,
  m.member_category,
  m.reply_to_id,
  m.bot_lang,
  m.search_body,
  m.search,
  -- True only when the public text actually differs from what she sent, so the
  -- admin console cannot show "redacted" for a pattern that matched nothing.
  (m.text_body IS DISTINCT FROM CASE
     WHEN m.is_bot AND r.pattern IS NOT NULL AND m.text_body IS NOT NULL
       THEN regexp_replace(
              m.text_body, r.pattern,
              replace(
                COALESCE(
                  pj.persona -> m.bot_lang ->> 'redactedMember',
                  pj.persona -> 'en' ->> 'redactedMember',
                  'that member'
                ), '\', '\\'
              ), 'g'
            )
     ELSE m.text_body
   END) AS redacted
FROM messages m
JOIN message_publish_state s ON s.id = m.id
LEFT JOIN LATERAL (
  SELECT '(?<![[:alnum:]_])(' || string_agg(
           mm.display_pattern,
           '|'
           -- Longest first, so `Ann Marie` is consumed whole before `Ann` can
           -- take a bite out of it. Also makes the pattern deterministic.
           ORDER BY length(mm.display_pattern) DESC, mm.display_pattern
         ) || ')(?![[:alnum:]_])' AS pattern
  FROM message_mentions mm
  LEFT JOIN consent mc ON mc.member_id = mm.member_id
  WHERE mm.message_id = m.id
    AND mm.display_name <> ''
    AND (mm.member_id IS NULL OR mc.member_id IS NULL OR mc.revoked_at IS NOT NULL)
) r ON m.is_bot
-- The placeholder is a persona string: operator-editable, and localised to the
-- language she answered in.
--
-- TWO THINGS ABOUT IT MATTER.
--
-- It is READ ONCE, not per row. The persona JSON is fetched by a scalar subquery
-- inside a one-row FROM, so the planner evaluates it a single time — the live
-- front polls these views every few seconds and they must stay cheap.
--
-- And it is ESCAPED. `regexp_replace` interprets backslashes in the REPLACEMENT
-- string: `\&` re-emits the whole match. An operator who typed a backslash into
-- this persona string would therefore have printed the very name being redacted,
-- straight back into the public archive. Doubling the backslashes makes it a
-- literal. The COALESCE chain also guarantees a non-null replacement, because a
-- null one would turn the entire message body into NULL.
CROSS JOIN (
  SELECT (SELECT value -> 'persona' FROM settings WHERE key = 'interaction') AS persona
) pj
WHERE s.published;
