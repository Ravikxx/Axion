-- Migration 009: redeemable API credits and account-level usage budgets.

ALTER TABLE users ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN included_month_cost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN usage_month TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN included_window_cost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN usage_window TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN usage_limit_notified TEXT DEFAULT NULL;

-- Preserve usage already recorded on existing keys for the current month so
-- deploying this migration cannot accidentally grant a second allowance.
UPDATE users
SET included_month_cost = COALESCE((
      SELECT SUM(api_keys.month_cost)
      FROM api_keys
      WHERE api_keys.user_id = users.id
        AND api_keys.last_used >= strftime('%s','now','start of month')
    ), 0),
    usage_month = strftime('%Y-%m','now');

CREATE TABLE IF NOT EXISTS credit_codes (
  id                  TEXT PRIMARY KEY,
  code_hash           TEXT UNIQUE NOT NULL,
  code_hint           TEXT NOT NULL,
  credit_microdollars INTEGER NOT NULL CHECK (credit_microdollars >= 0),
  variable_amount     INTEGER NOT NULL DEFAULT 0,
  max_credit_microdollars INTEGER NOT NULL DEFAULT 10000000000,
  allow_repeat        INTEGER NOT NULL DEFAULT 0,
  max_redemptions     INTEGER NOT NULL DEFAULT 1 CHECK (max_redemptions >= 0),
  redemption_count    INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  expires_at          INTEGER,
  active              INTEGER NOT NULL DEFAULT 1,
  note                TEXT NOT NULL DEFAULT '',
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS credit_redemptions (
  id                  TEXT PRIMARY KEY,
  code_id             TEXT NOT NULL REFERENCES credit_codes(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  credit_microdollars INTEGER NOT NULL,
  repeatable          INTEGER NOT NULL DEFAULT 0,
  redeemed_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  CHECK (credit_microdollars > 0)
);

CREATE INDEX IF NOT EXISTS idx_credit_codes_hash ON credit_codes (code_hash);
CREATE INDEX IF NOT EXISTS idx_credit_redemptions_user ON credit_redemptions (user_id, redeemed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_redemptions_once
  ON credit_redemptions (code_id, user_id) WHERE repeatable=0;
