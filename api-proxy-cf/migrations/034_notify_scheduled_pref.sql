-- Whether to email the user when a scheduled task's generation finishes (or
-- fails). Defaults on: unlike a regular chat reply the user is looking at
-- when it lands, a scheduled task fires with nobody watching the tab.
ALTER TABLE email_prefs ADD COLUMN notify_scheduled INTEGER DEFAULT 1;
