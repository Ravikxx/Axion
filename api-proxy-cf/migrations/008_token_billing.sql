-- Migration 008: Token/dollar-denominated usage tracking (2026-07-19)

-- Accumulated cost in microdollars (1,000,000 = $1) for the current billing
-- month — resets alongside month_requests on month rollover (same month_start
-- column gates both). Denominated in dollars, not raw tokens, since input and
-- output tokens are priced differently ($0.15/M vs $0.50/M) and this is the
-- same unit the future pay-as-you-go credits feature will use.
ALTER TABLE api_keys ADD COLUMN month_cost INTEGER DEFAULT 0;
