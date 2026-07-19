-- Migration 011: switch the account-wide included-usage allowance from a
-- calendar month to a week, and make both it and the two-hour window
-- lazy-start.
--
-- Previously usage_month/usage_window held a calendar-month label and a
-- clock-grid-aligned bucket id — both reset for every account at the same
-- global instant regardless of whether that account had used anything,
-- so the dashboard could show a live countdown to a reset nobody's usage
-- ever triggered. usage_week/usage_window now hold the ISO timestamp the
-- current period actually started (empty string = never started); a
-- period only begins, and only counts down, from an account's own first
-- chargeable request after the previous one fully elapsed.
--
-- Old calendar-month/grid values don't map onto that scheme, so every
-- account starts fresh under the new model.

ALTER TABLE users RENAME COLUMN included_month_cost TO included_week_cost;
ALTER TABLE users RENAME COLUMN usage_month TO usage_week;

UPDATE users SET
  included_week_cost = 0,
  usage_week = '',
  included_window_cost = 0,
  usage_window = '';

ALTER TABLE admin_account_edits RENAME COLUMN previous_month_cost TO previous_week_cost;
ALTER TABLE admin_account_edits RENAME COLUMN new_month_cost TO new_week_cost;
