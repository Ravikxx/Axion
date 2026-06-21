-- Run these in the Cloudflare D1 console or via wrangler d1 execute

-- API key scopes (null = all models allowed)
ALTER TABLE api_keys ADD COLUMN scopes TEXT DEFAULT NULL;
-- Track which month we last sent an 80% usage warning to avoid repeat emails
ALTER TABLE api_keys ADD COLUMN limit_notified TEXT DEFAULT NULL;

-- Waitlist: public signups waiting for an invite
CREATE TABLE IF NOT EXISTS waitlist (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email           TEXT NOT NULL UNIQUE,
  created_at      INTEGER DEFAULT (strftime('%s','now')),
  status          TEXT DEFAULT 'pending',  -- pending | approved | rejected
  invite_token    TEXT UNIQUE,
  invite_expires  INTEGER,
  approved_by     TEXT,
  approved_at     INTEGER
);

-- Per-user email notification preferences
CREATE TABLE IF NOT EXISTS email_prefs (
  user_id              TEXT PRIMARY KEY REFERENCES users(id),
  notify_limit         INTEGER DEFAULT 1,   -- 80% usage warning
  notify_announcements INTEGER DEFAULT 1    -- product announcements
);

-- Announcements (admin creates, auto-emailed to opted-in users)
CREATE TABLE IF NOT EXISTS announcements (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  sent_at    INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Email-only subscribers (no account needed to subscribe to announcements)
CREATE TABLE IF NOT EXISTS subscribers (
  email      TEXT PRIMARY KEY,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  active     INTEGER DEFAULT 1,
  unsub_token TEXT UNIQUE DEFAULT (lower(hex(randomblob(16))))
);
