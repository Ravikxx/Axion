-- Durable moderation runs and human-review state for the admin safety workflow.
-- The automated classifier result remains in review_status/review_notes; admins
-- record a separate disposition so dismissing a false positive never rewrites
-- the original model decision.

CREATE TABLE moderation_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL, -- 'scheduled' | 'manual'
  started_by TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  reviewed_count INTEGER NOT NULL DEFAULT 0,
  flagged_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  failure_notes TEXT
);

ALTER TABLE message_log ADD COLUMN review_run_id TEXT REFERENCES moderation_runs(id);
ALTER TABLE message_log ADD COLUMN human_review_status TEXT; -- NULL/'pending' | 'dismissed' | 'confirmed'
ALTER TABLE message_log ADD COLUMN human_reviewed_at INTEGER;
ALTER TABLE message_log ADD COLUMN human_reviewed_by TEXT;

CREATE INDEX idx_moderation_runs_started ON moderation_runs(started_at DESC);
CREATE INDEX idx_message_log_review_run ON message_log(review_run_id);
CREATE INDEX idx_message_log_user_flagged ON message_log(user_id, review_status, created_at DESC);
