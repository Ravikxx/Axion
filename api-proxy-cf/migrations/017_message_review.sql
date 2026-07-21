-- Async safety review state for message_log rows. Never touched by the
-- live chat request path — only the scheduled review job (see
-- src/messageReview.js) writes these columns, well after the exchange
-- already happened.
ALTER TABLE message_log ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'; -- 'pending' | 'safe' | 'flagged'
ALTER TABLE message_log ADD COLUMN reviewed_at INTEGER;
ALTER TABLE message_log ADD COLUMN review_notes TEXT;
CREATE INDEX idx_message_log_review_status ON message_log(review_status);
