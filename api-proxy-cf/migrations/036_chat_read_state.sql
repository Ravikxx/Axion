-- Per-chat read state for the owning user. A chat is unread when it has an
-- assistant message newer than this timestamp. Zero means explicitly unread.
ALTER TABLE chats ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0;
