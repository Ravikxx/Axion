-- Append-only audit log of every chat completion exchange, independent of
-- the mutable/deletable `chats` table (which reflects what the user's own
-- UI currently shows, not a permanent record — editing or deleting a
-- message there removes it from that table). Covers every request path:
-- signed-in session, API key, and anonymous/keyless. Nothing in the app
-- ever updates or deletes rows here.
CREATE TABLE message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  api_key_id TEXT,
  ip TEXT NOT NULL,
  auth_type TEXT NOT NULL, -- 'session' | 'api_key' | 'anonymous'
  model TEXT,
  request_messages TEXT NOT NULL, -- JSON array, exactly as submitted by the client
  response_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_message_log_user ON message_log(user_id);
CREATE INDEX idx_message_log_created ON message_log(created_at);
CREATE INDEX idx_message_log_ip ON message_log(ip);
