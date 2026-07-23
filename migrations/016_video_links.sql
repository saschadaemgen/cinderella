-- Video-link cards (CCB-S3-014).
--
-- WHY THIS EXISTS: a YouTube link posted in the group appeared in the public
-- archive as a bare link. It should play, the way an uploaded video does — but a
-- normal YouTube embed loads Google's player and trackers into every visitor's
-- browser on page load, which is precisely the third-party loading the product
-- exists not to do. So the card is CLICK-TO-PLAY: nothing from any third party
-- loads until the visitor deliberately clicks, and the thumbnail is served from
-- our own domain.
--
-- What a video link needs beyond an ordinary link: which provider, the video id,
-- an optional start offset, and a title. The THUMBNAIL is stored as the message's
-- own media (media_path -> media_derived_path), so it inherits the whole
-- CCB-S3-011 machinery for free — stripped, fail-closed, self-healing, consent-
-- gated through published_messages — with no second serving path.

ALTER TABLE messages ADD COLUMN video_provider TEXT;
ALTER TABLE messages ADD COLUMN video_id TEXT;
ALTER TABLE messages ADD COLUMN video_start INTEGER;
ALTER TABLE messages ADD COLUMN video_title TEXT;

/* ── The public projection must carry the new columns ────────────────────── */

-- As in 013/014/015: the view is an explicit column list, so a new column is
-- invisible to every public reader until it is named here.
DROP VIEW published_messages;

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
  m.video_provider,
  m.video_id,
  m.video_start,
  m.video_title,
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
