-- Cinderella's own messages in the archive (CCB-S3-007).
--
-- WHY THIS EXISTS: publication derives from member consent, and Cinderella has no
-- consent row, so her side of every exchange was missing from the public archive
-- and published conversations read as one-sided.
--
-- She is NOT a member giving consent. Fabricating a consent row for her would
-- corrupt the one table whose meaning the whole product rests on — consent is a
-- member's own decision about their own words, and nothing else may be written
-- there. Her publication is therefore a SEPARATE branch of the same derivation:
-- the operator's setting decides, and the consent table is not touched.
--
-- Three things this migration must get right:
--
--  1. STILL DERIVED. Publication stays a view, never a stored flag, so switching
--     the setting off removes her messages everywhere at once — stream, search,
--     counts, sitemap, live-poll hashes — with no backfill and no remnant.
--
--  2. THE LEAK GUARD. Her replies can name other members (the mention prefix, and
--     refusals such as "Only Robin can open that door"). Publishing those would
--     put a non-consenting member's name into the public archive THROUGH her
--     message, around the gate. The guard lives here, in the derivation, so it
--     cannot be bypassed by a future reply type and so a later /unpublish
--     retroactively redacts a name that was published while consent stood.
--
--  3. NEVER TAKE THE ARCHIVE DOWN. A view that throws makes every public read
--     fail. Verified against real Postgres: `('maybe')::boolean`, `('')::boolean`
--     and a JSON number all raise — so a single malformed settings value would
--     have taken the whole public archive offline. Every scalar read below is
--     therefore compared as JSON rather than cast, so nothing here can raise. An
--     ABSENT setting takes the shipped default; a PRESENT but malformed one reads
--     as "off", because the safe reading of a broken settings row is to publish
--     less rather than more.
--
-- Redaction ERRS TOWARD REDACTING TOO MUCH. A name that is also an ordinary word
-- will be replaced where the word was meant. That is the correct direction to
-- fail: an over-redacted sentence is clumsy, an under-redacted one is a breach.

/* ── 1. Her messages, and what she named in them ─────────────────────────── */

-- Set on rows Cinderella herself sent. Nothing keys off the sender id: the
-- branch below tests this column, so her member id carrying a consent row (it
-- never should) still could not publish her through the member branch.
ALTER TABLE messages ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT FALSE;

-- Which kind of reply this was, declared by the handler that produced it. NULL
-- means unclassified — a new reply site nobody categorised — and unclassified is
-- NOT published, so forgetting to classify fails safe.
ALTER TABLE messages ADD COLUMN bot_category TEXT;

-- The language she answered in, so the redaction placeholder can be localised.
ALTER TABLE messages ADD COLUMN bot_lang TEXT;

-- Set only by the writer that also scans the reply for member names. Without it,
-- "this reply named nobody" and "nobody ever looked" are the same state — and
-- under the redact guard the second one publishes a name in the clear. Any future
-- path that writes a bot row without scanning gets a row that cannot publish.
ALTER TABLE messages ADD COLUMN mentions_scanned BOOLEAN NOT NULL DEFAULT FALSE;

-- The text this row contributes to FULL-TEXT SEARCH. For her messages it is the
-- reply with every member name already replaced, so no member's name is findable
-- through her words — without it, a visitor searching a redacted name would still
-- get the card back and learn that it names them. NULL for member messages, which
-- keep searching their own text.
ALTER TABLE messages ADD COLUMN search_body TEXT;

-- Every member name that appears in one of her messages, resolved to a member id
-- where we could identify one. member_id NULL means the name could not be tied to
-- a member — treated as NOT publishable, because an unidentifiable name is one
-- whose consent we cannot demonstrate.
CREATE TABLE message_mentions (
  message_id   BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  member_id    TEXT,
  -- EXACTLY the text embedded in the message, after display-name sanitising, so
  -- the redaction below can find it verbatim.
  display_name TEXT   NOT NULL,
  -- The same string, regex-escaped, written by `escapeRegex` in
  -- src/archive/redact.ts. Escaping here rather than in the view is not a
  -- shortcut: a backslash has to survive the SQL literal, the replacement
  -- grammar of regexp_replace, AND the regex, and it was verified against real
  -- Postgres not to — `Ro[b]in.*` escaped in SQL came back as an invalid
  -- backreference, which made the pattern throw and would have published the
  -- name unredacted. One escaper, in the language that can test it.
  display_pattern TEXT NOT NULL
);

CREATE INDEX message_mentions_message_id_idx ON message_mentions (message_id);
CREATE INDEX message_mentions_member_id_idx ON message_mentions (member_id);
-- One row per (message, name, member). A retry must not be able to accumulate
-- duplicates, which would only bloat the redaction pattern.
CREATE UNIQUE INDEX message_mentions_unique_idx
  ON message_mentions (message_id, display_name, coalesce(member_id, ''));

/* ── 2. Re-point full-text search at search_body ─────────────────────────── */

-- A generated column's expression cannot be altered, so it is dropped and
-- rebuilt. The dependent views are recreated below in any case.
DROP VIEW published_messages;
DROP VIEW message_publish_state;

-- Note the asymmetry, which is deliberate. A MEMBER row indexes its own text. A
-- BOT row indexes `search_body` and nothing else, so a bot row that somehow
-- reaches the table without one is simply not searchable. Falling back to
-- `text_body` there would have been fail-OPEN: the row would quietly index the
-- unredacted reply, and a visitor searching a redacted name would get the card
-- back and learn that it names them.
ALTER TABLE messages DROP COLUMN search;
ALTER TABLE messages ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector(
    'simple',
    CASE WHEN is_bot THEN coalesce(search_body, '') ELSE coalesce(text_body, '') END
      || ' ' || coalesce(links_text, '')
  )
) STORED;

-- And make the fail-closed case loud rather than silent: her messages must carry
-- the text they are indexed by.
ALTER TABLE messages ADD CONSTRAINT messages_bot_search_body
  CHECK (is_bot = FALSE OR search_body IS NOT NULL);

CREATE INDEX messages_search_idx ON messages USING GIN (search);

/* ── 3. The operator's publication settings, read live ───────────────────── */

-- Exactly one row, always — the scalar subquery yields NULL when the operator has
-- never saved anything, and every field then falls back to its shipped default.
-- The defaults are duplicated in `normalizeArchive` (src/archive/settings.ts); the
-- admin-views harness asserts the two agree, so they cannot drift apart silently.
CREATE VIEW bot_publish_settings AS
SELECT
  -- Absent means "never configured", which takes the shipped default of TRUE.
  -- PRESENT BUT MALFORMED means something is wrong with the settings, and the
  -- safe reading of "something is wrong" is to publish less, not more.
  CASE
    WHEN v -> 'publishBotMessages' IS NULL THEN TRUE
    ELSE v -> 'publishBotMessages' = 'true'::jsonb
  END AS publish_bot,
  CASE
    WHEN v ->> 'mentionGuard' = 'withhold' THEN 'withhold'
    ELSE 'redact'
  END AS mention_guard,
  -- These MUST match DEFAULT_ARCHIVE in src/archive/settings.ts; the
  -- admin-views harness compares the two and fails if they drift.
  '{"consent": true,  "price": true,
    "search": false, "status": false, "help": false,
    "notUnderstood": false, "nickname": false, "disambiguation": false}'::jsonb
    || CASE
         WHEN jsonb_typeof(v -> 'categories') = 'object' THEN v -> 'categories'
         ELSE '{}'::jsonb
       END AS categories
FROM (SELECT (SELECT value FROM settings WHERE key = 'archive') AS v) t;

/* ── 4. The derivation ───────────────────────────────────────────────────── */

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
    AND CASE
      WHEN m.is_bot THEN
        b.publish_bot
        -- Unclassified never publishes.
        AND m.bot_category IS NOT NULL
        -- Compared as JSON rather than cast to boolean: a cast can RAISE, and a
        -- raise here takes every public read down with it. Anything that is not
        -- exactly `true` — a typo, a string, a missing key — reads as excluded.
        AND b.categories -> m.bot_category = 'true'::jsonb
        -- A row whose names were never scanned is not the same thing as a row
        -- that named nobody, and only the second one is safe to publish.
        AND m.mentions_scanned
        -- In `withhold` mode a single unpublishable name suppresses the whole
        -- message; in `redact` mode it publishes with the name replaced (below).
        AND (b.mention_guard <> 'withhold' OR NOT EXISTS (
              SELECT 1
              FROM message_mentions mm
              LEFT JOIN consent mc ON mc.member_id = mm.member_id
              WHERE mm.message_id = m.id
                AND (mm.member_id IS NULL OR mc.member_id IS NULL OR mc.revoked_at IS NOT NULL)
            ))
      ELSE
        -- The member branch, unchanged since migration 005.
        c.member_id IS NOT NULL
        AND c.revoked_at IS NULL
        AND m.sent_at >= c.opted_in_at
    END
  ) AS published
FROM messages m
LEFT JOIN consent c ON c.member_id = m.sender_member_id
CROSS JOIN bot_publish_settings b;

/* ── 5. The public projection, with names redacted at read time ──────────── */

-- Redaction is computed HERE rather than stored, which is what makes it
-- retroactive: the moment a named member revokes, their name disappears from her
-- published messages, and the content markers the live front polls on change with
-- it so loaded pages reconcile.
--
-- The pattern is built from the names themselves, so it is escaped and bounded:
--   · every metacharacter in a display name is already escaped in
--     `display_pattern`, so a member calling themselves `.*` cannot rewrite the
--     pattern into one that redacts every message she ever sent;
--   · each name is anchored by NEGATIVE LOOKAROUND rather than by \y. Both stop
--     "Ann" from rewriting "Anna" into "[redacted]a", but \y additionally
--     REQUIRES a word character on the inside edge, so a display name that
--     starts or ends with punctuation or an emoji — `[Admin] Robin`, `🌸Lily`,
--     `.*` — would never match and the name would publish. That is fail-open on
--     exactly the names a member can choose for themselves;
--   · empty names are excluded, because an empty alternative matches at every
--     position and would shred the whole sentence (verified).
--
-- Columns are enumerated rather than `m.*` because text_body is overridden. That
-- costs something real — migration 004 recreated this view precisely SO that
-- `m.*` would pick up new columns automatically, and that no longer happens, so a
-- future column must be added here too.
--
-- It buys something real as well: `raw_json` is now deliberately ABSENT. For one
-- of her replies that quotes a member, the raw chat item contains that member's
-- full text and profile — a non-consenting member's words verbatim, sitting in a
-- view named `published_messages`. Nothing reads it publicly today, and now
-- nothing can.
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
