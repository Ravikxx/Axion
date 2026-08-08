-- user_settings was originally created with INTEGER PRIMARY KEY even though
-- users.id is TEXT. SQLite treats INTEGER PRIMARY KEY as the rowid, so the
-- first settings write for a real user fails with SQLITE_MISMATCH.
CREATE TABLE user_settings_v2 (
  user_id                 TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selected_model          TEXT,
  onboarding_completed_at INTEGER,
  updated                 INTEGER NOT NULL,
  legal_accepted_at       INTEGER,
  terms_version           TEXT,
  privacy_version         TEXT,
  onboarding_step         TEXT,
  onboarding_tour         TEXT,
  onboarding_preferences  TEXT,
  revision                INTEGER NOT NULL DEFAULT 0
);

INSERT INTO user_settings_v2 (
  user_id, selected_model, onboarding_completed_at, updated,
  legal_accepted_at, terms_version, privacy_version, onboarding_step,
  onboarding_tour, onboarding_preferences, revision
)
SELECT
  CAST(user_id AS TEXT), selected_model, onboarding_completed_at, updated,
  legal_accepted_at, terms_version, privacy_version, onboarding_step,
  onboarding_tour, onboarding_preferences, revision
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_v2 RENAME TO user_settings;
