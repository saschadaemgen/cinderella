-- Cinderella archive schema — Season 0.
-- Applied by src/db/migrate.ts (each migration runs once, inside a transaction).

-- Capture type taxonomy (briefing §5/§7).
CREATE TYPE message_type AS ENUM ('text', 'image', 'video', 'voice', 'link', 'file');

-- Placeholder hook for the separate moderation track (briefing §4). Not driven
-- by anything in Season 0 — every row stays 'none' until that track is built.
CREATE TYPE moderation_state AS ENUM ('none', 'pending', 'approved', 'rejected');

CREATE TABLE messages (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SimpleX group (local numeric id) and chat-item id. group_msg_id is the
  -- chatItem meta.itemId, which in-group deletion events refer to (Stage 3).
  group_id            BIGINT           NOT NULL,
  group_msg_id        BIGINT           NOT NULL,
  -- Stable shared message id (base64), useful for tracing across members.
  shared_msg_id       TEXT,
  -- Stable group member id — NEVER the display name (briefing §9).
  sender_member_id    TEXT             NOT NULL,
  sender_display_name TEXT             NOT NULL,
  sent_at             TIMESTAMPTZ      NOT NULL,
  type                message_type     NOT NULL,
  text_body           TEXT,
  -- Concatenated extracted link text (url/title/description) so it is covered by
  -- full-text search even when not present in text_body.
  links_text          TEXT,
  -- Media lives on disk; the DB stores the path (relative to MEDIA_ROOT), mime,
  -- and size — never the bytes.
  media_path          TEXT,
  media_mime          TEXT,
  media_size          BIGINT,
  -- In-group deletions flip this true; deleted rows are excluded from publishing.
  deleted             BOOLEAN          NOT NULL DEFAULT FALSE,
  moderation_state    moderation_state NOT NULL DEFAULT 'none',
  raw_json            JSONB            NOT NULL,
  captured_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  -- Generated full-text vector over the text body + extracted link text.
  -- 'simple' config: language-agnostic (the archive may be multilingual).
  search              tsvector GENERATED ALWAYS AS (
                        to_tsvector(
                          'simple',
                          coalesce(text_body, '') || ' ' || coalesce(links_text, '')
                        )
                      ) STORED,
  CONSTRAINT messages_group_msg_unique UNIQUE (group_id, group_msg_id)
);

-- Fast type + time filtering for the future web front.
CREATE INDEX messages_type_sent_at_idx ON messages (type, sent_at);
-- Full-text search.
CREATE INDEX messages_search_idx ON messages USING GIN (search);
-- Consent/publish derivation and per-member queries (Stage 3).
CREATE INDEX messages_sender_idx ON messages (sender_member_id);
CREATE INDEX messages_sent_at_idx ON messages (sent_at);

CREATE TABLE links (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id          BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  url                 TEXT   NOT NULL,
  title               TEXT,
  preview_description TEXT
);

CREATE INDEX links_message_id_idx ON links (message_id);
