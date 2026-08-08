-- Short-lived, PKCE-bound handoff for Desktop integration OAuth tokens.
-- Provider tokens are AES-GCM encrypted with TOKEN_SECRET and are deleted
-- after redemption/expiry; the custom-protocol callback carries only a
-- single-use code, never a provider credential.
CREATE TABLE desktop_integration_codes (
  code            TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  token_payload   TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  redeemed_at     INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_desktop_integration_codes_expires
  ON desktop_integration_codes(expires_at);
