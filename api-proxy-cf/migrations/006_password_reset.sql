-- Migration 006: Password reset + session invalidation (2026-07-12)

ALTER TABLE users ADD COLUMN reset_token TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN reset_token_expires INTEGER DEFAULT NULL;

-- Bumped whenever a password is reset so every session token issued before
-- the reset (they embed the version at mint time) stops validating in
-- requireAuth. Existing tokens already in the wild decode with no `v` field,
-- which reads as 0 — same as this column's default — so live sessions are
-- unaffected by this migration; only a future reset invalidates them.
ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token);
