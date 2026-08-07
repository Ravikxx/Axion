-- Migration 010: audit admin-only account testing overrides.

CREATE TABLE IF NOT EXISTS admin_account_edits (
  id                         TEXT PRIMARY KEY,
  user_id                    TEXT NOT NULL REFERENCES users(id),
  admin_email                TEXT NOT NULL,
  previous_plan              TEXT NOT NULL,
  new_plan                   TEXT NOT NULL,
  previous_month_cost        INTEGER NOT NULL,
  new_month_cost             INTEGER NOT NULL,
  previous_window_cost       INTEGER NOT NULL,
  new_window_cost            INTEGER NOT NULL,
  previous_credit_balance    INTEGER NOT NULL,
  new_credit_balance         INTEGER NOT NULL,
  created_at                 INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_account_edits_user
  ON admin_account_edits (user_id, created_at DESC);
