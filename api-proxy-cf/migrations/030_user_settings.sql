-- Cloud-authoritative user preferences, so they follow the account across
-- devices/windows instead of living in one client's localStorage. One row
-- per user, created lazily on first write.
CREATE TABLE user_settings (
  user_id                INTEGER PRIMARY KEY,
  selected_model         TEXT,
  onboarding_completed_at INTEGER,
  updated                INTEGER NOT NULL
);
