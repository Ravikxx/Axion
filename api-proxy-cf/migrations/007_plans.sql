-- Migration 007: Subscription plans (2026-07-19)

ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free';
ALTER TABLE users ADD COLUMN plan_updated_at INTEGER DEFAULT NULL;
ALTER TABLE users ADD COLUMN square_customer_id TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN square_subscription_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_square_customer ON users (square_customer_id);
