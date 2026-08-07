-- Scheduled contains recurring automations, reminders, monitors, and future
-- tasks. This is the definition only — schedule, prompt, enabled state.
-- Actually running a definition on its cron and updating next_run_at/
-- last_run_at is a separate execution engine, not part of this table.
CREATE TABLE scheduled_definitions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  project_id    TEXT,
  chat_id       TEXT,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  schedule      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_run_at   INTEGER,
  last_run_at   INTEGER,
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL
);

CREATE INDEX idx_scheduled_user ON scheduled_definitions (user_id, updated DESC);
