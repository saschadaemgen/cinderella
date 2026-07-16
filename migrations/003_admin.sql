-- Cinderella admin console foundation — Season 0, Stage 4 (Addendum 1 / A3, A6).

-- Live-editable operator settings. Boot/secret settings (DB connection, admin
-- credentials, session secret) NEVER live here — they are environment-only.
CREATE TABLE settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every state-changing admin action is recorded (who/what/when) — A3 §5.
CREATE TABLE audit_log (
  id      BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT        NOT NULL,
  action  TEXT        NOT NULL,
  target  TEXT,
  details JSONB
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- Embed instances (A4): instance-id -> design/theme/filter settings for the
-- future public widget. The /embed/<instance-id> route and widget rendering are
-- a later season; Season 0 builds the data model + admin UI + snippet generator.
CREATE TABLE embed_instances (
  id         TEXT        PRIMARY KEY,
  name       TEXT        NOT NULL,
  -- Widget design/behaviour: theme (mode/colors), layout, enabled filters,
  -- media-type visibility. Validated/normalized by the application.
  settings   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
