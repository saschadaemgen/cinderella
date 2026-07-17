-- Cinderella passkeys / WebAuthn + break-glass TOTP — Addendum 4.

-- Registered WebAuthn credentials (passkeys). One operator, many authenticators.
CREATE TABLE webauthn_credentials (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Base64url credential id (from the authenticator). Unique.
  credential_id TEXT        NOT NULL UNIQUE,
  -- COSE public key bytes.
  public_key    BYTEA       NOT NULL,
  -- Signature counter; monotonic. Regression => possible cloned authenticator.
  counter       BIGINT      NOT NULL DEFAULT 0,
  transports    TEXT[]      NOT NULL DEFAULT '{}',
  aaguid        TEXT,
  -- Operator-facing label.
  name          TEXT        NOT NULL DEFAULT 'passkey',
  backed_up     BOOLEAN     NOT NULL DEFAULT FALSE,
  device_type   TEXT,
  -- Set when a counter regression locked this credential (cloned-authenticator signal).
  locked        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

-- Break-glass TOTP secret (optional second factor for the password path).
-- Single row (id = TRUE). The secret is never rendered in the admin — only its
-- enabled status. Protected by DB access controls, like every other secret.
CREATE TABLE admin_totp (
  id         BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
  secret     TEXT        NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
