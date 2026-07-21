-- Migration 013: backfill CREATE TABLE statements for tables that were
-- created directly against D1 (wrangler d1 execute) at some point and never
-- got a matching migration file — src/index.js has queried all of these for
-- a while, but `git log migrations/` had no record of where they came from.
-- Everything here uses IF NOT EXISTS so this is a no-op against the existing
-- production database; its purpose is to make the schema fully
-- reconstructable from a clean checkout (fresh dev DB, disaster recovery)
-- instead of only existing as tribal knowledge in the live D1 instance.

-- Admins allowed to use /admin/* (checked by requireAdmin in src/index.js).
CREATE TABLE IF NOT EXISTS admin_allowlist (
  email      TEXT PRIMARY KEY,
  added_by   TEXT NOT NULL DEFAULT '',
  added_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- One-time links an existing admin can send to grant someone else access to
-- the admin panel (POST /admin/invite, GET /admin/invite/accept).
CREATE TABLE IF NOT EXISTS admin_invites (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  invited_by  TEXT NOT NULL DEFAULT '',
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- CLI device-code login flow (POST /auth/device, /auth/device/authorize,
-- GET /auth/device/poll). user_id is NULL until the browser side authorizes
-- the code; rows are deleted once polled successfully or left to expire.
CREATE TABLE IF NOT EXISTS device_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Teams (POST /orgs). owner_id is the one member who can rename/delete the
-- org and is never removable via DELETE /orgs/:id/members/:uid.
CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Org membership + role ('owner' | 'member'). Only an existing owner may
-- grant the 'owner' role via POST /orgs/:id/invite (see the fix that added
-- that check) — a plain member could otherwise hand out full org control.
CREATE TABLE IF NOT EXISTS org_members (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'member',
  joined_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (org_id, user_id)
);

-- Pending org invites (POST /orgs/:id/invite, POST /orgs/invite/accept).
CREATE TABLE IF NOT EXISTS org_invites (
  token       TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  invited_by  TEXT NOT NULL DEFAULT '',
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Generic sliding-window counter keyed by an arbitrary string (`auth:<ip>`,
-- `free:<ip>`, `<action>:<uid>`, etc.) — shared by every rate limit in
-- src/index.js. window_start is sometimes an epoch-second integer and
-- sometimes a 'YYYY-MM-DD' date string depending on the caller; SQLite's
-- type affinity stores either without complaint, which is why a single
-- loosely-typed column works for both.
CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL
);

-- Per-key, per-day request counter backing GET /dashboard/daily and
-- GET /admin/daily. (org_id-scoped keys and personal keys share this table
-- via api_keys.id.)
CREATE TABLE IF NOT EXISTS usage_daily (
  key_id  TEXT NOT NULL REFERENCES api_keys(id),
  date    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, date)
);
