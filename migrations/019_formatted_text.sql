-- CCB-S3-025: carry the chat's own text formatting into the archive.
--
-- SimpleX delivers the parsed formatting runs (ChatItem.formattedText) on every
-- item, but the public view surfaced only the plain text, so a member's *bold*
-- showed as literal asterisks. The runs are ALREADY stored: capture keeps the whole
-- AChatItem in raw_json, so chatItem.formattedText is present on every row (existing
-- and future). This republishes the public view to DERIVE a compact, redaction-safe
-- formatted_text ({f,t} per run) from raw_json -- no new column, no backfill, no
-- capture change, and it covers historical rows too.
--
-- REDACTION SAFETY: for one of HER (bot) messages, the view redacts a mentioned
-- non-consenting member's name out of text_body. The structured runs hold the same
-- text UNREDACTED, so the view emits formatted_text as NULL whenever that redaction
-- can apply (m.is_bot AND a redaction pattern exists); the renderer then falls back
-- to the already-redacted plain text_body. A member's own message is never redacted,
-- so its runs always render. The runs can never bypass name redaction.
--
-- PERFORMANCE: the derivation is a correlated subquery over raw_json. The hot poll
-- endpoints select only id + a text/media marker, so the planner prunes this
-- unreferenced output column and never evaluates it there; only the page / item /
-- feed reads (<= 40 rows) compute it, which is negligible.

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
  -- Structured formatting runs (CCB-S3-025), derived from the stored raw item and
  -- suppressed to NULL whenever a bot message's mention-redaction could alter its
  -- text, so the runs can never carry an unredacted mentioned name to the public.
  CASE
    WHEN m.is_bot AND r.pattern IS NOT NULL THEN NULL
    WHEN jsonb_typeof(m.raw_json -> 'chatItem' -> 'formattedText') = 'array' THEN (
      SELECT jsonb_agg(
               jsonb_build_object('f', e.value -> 'format' ->> 'type', 't', e.value ->> 'text')
               ORDER BY e.ord
             )
      FROM jsonb_array_elements(m.raw_json -> 'chatItem' -> 'formattedText')
        WITH ORDINALITY AS e(value, ord)
    )
    ELSE NULL
  END AS formatted_text,
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
           ORDER BY length(mm.display_pattern) DESC, mm.display_pattern
         ) || ')(?![[:alnum:]_])' AS pattern
  FROM message_mentions mm
  LEFT JOIN consent mc ON mc.member_id = mm.member_id
  WHERE mm.message_id = m.id
    AND mm.display_name <> ''
    AND (mm.member_id IS NULL OR mc.member_id IS NULL OR mc.revoked_at IS NOT NULL)
) r ON m.is_bot
CROSS JOIN (
  SELECT (SELECT value -> 'persona' FROM settings WHERE key = 'interaction') AS persona
) pj
WHERE s.published;
