-- Stripped media derivatives (CCB-S3-011 §1).
--
-- WHY THIS EXISTS: the public archive served the file exactly as the member sent
-- it. For a photograph that means EXIF — GPS coordinates, camera make, model and
-- serial, capture time — published to an indexed page. A member who agreed to
-- publish their words did not agree to publish where they were standing.
--
-- The fix is a DERIVATIVE, not an edit. The original stays byte-for-byte on disk
-- for the operator, for moderation, and for any preserve-and-report obligation;
-- the public path serves the stripped copy and nothing else. Destroying the
-- original to protect privacy would trade one irreversible problem for another.
--
-- Note what is NOT here: the public URL. It has always been `/media/<message-id>`
-- — opaque, no filename, no path — and the sitemap, feed and JSON-LD all build
-- the same form. Verified before changing anything, so this migration adds only
-- what was actually missing.

-- Path of the stripped copy, relative to MEDIA_ROOT. NULL means no derivative
-- exists yet, which the serving path treats as "not publishable", not as
-- "publish the original" — the safe reading of a missing derivative is that
-- stripping has not happened, and the whole point is that nothing unstripped is
-- ever served.
ALTER TABLE messages ADD COLUMN media_derived_path TEXT;

-- What the ORIGINAL was found to contain, as flags. Aggregate reporting only:
-- the operator can see that N files carried GPS without any coordinate ever being
-- copied into a second place. Values are never stored.
ALTER TABLE messages ADD COLUMN media_meta_found JSONB;

-- Set when the format has no stripper on this instance (video and documents need
-- ffmpeg, which is not installed). Recorded rather than assumed, so the admin can
-- show what the guarantee does NOT cover instead of implying it covers all.
ALTER TABLE messages ADD COLUMN media_strip_skipped TEXT;

CREATE INDEX messages_needs_strip_idx
  ON messages (id)
  WHERE media_path IS NOT NULL AND media_derived_path IS NULL;

/* ── The public projection must carry the new columns ────────────────────── */

-- Migration 013 replaced `SELECT m.*` with an explicit column list (so that
-- text_body could be overridden by the redaction), which means a new column is
-- invisible to every public reader until it is named here. That trade was
-- recorded in 013's comment; this is the first time it has to be paid.
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
