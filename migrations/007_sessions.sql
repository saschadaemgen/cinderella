-- Cinderella admin sessions — persist across restarts (hotfix).
--
-- Previously sessions lived in-process memory, so every `systemctl restart`
-- (deploys, config changes) wiped them and logged the operator out. Persisting
-- them here makes sessions survive restarts; the signed cookie already carries a
-- stable id (SESSION_SECRET is fixed in the environment).

CREATE TABLE admin_sessions (
  id              TEXT        PRIMARY KEY,
  username        TEXT        NOT NULL,
  csrf_token      TEXT        NOT NULL,
  auth_method     TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last successful passkey step-up (NULL = never; password logins start NULL).
  last_step_up_at TIMESTAMPTZ
);

CREATE INDEX admin_sessions_last_seen_idx ON admin_sessions (last_seen_at);
