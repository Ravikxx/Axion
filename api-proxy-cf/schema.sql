CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  pw_hash      TEXT NOT NULL,
  verified     INTEGER DEFAULT 0,
  verify_token TEXT,
  google_id    TEXT,
  github_id    TEXT,
  discord_id   TEXT,
  avatar_key   TEXT,
  avatar_updated_at INTEGER,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_value  TEXT UNIQUE NOT NULL,
  label      TEXT NOT NULL DEFAULT 'My Key',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  last_used  INTEGER,
  requests   INTEGER DEFAULT 0,
  tokens     INTEGER DEFAULT 0,
  revoked    INTEGER DEFAULT 0
);
