-- Increment 6: server-authoritative legal acceptance and onboarding state.
-- Local Desktop cache data must never be treated as proof of consent.
ALTER TABLE user_settings ADD COLUMN legal_accepted_at INTEGER;
ALTER TABLE user_settings ADD COLUMN terms_version TEXT;
ALTER TABLE user_settings ADD COLUMN privacy_version TEXT;
ALTER TABLE user_settings ADD COLUMN onboarding_step TEXT;
ALTER TABLE user_settings ADD COLUMN onboarding_tour TEXT;
ALTER TABLE user_settings ADD COLUMN onboarding_preferences TEXT;
ALTER TABLE user_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
