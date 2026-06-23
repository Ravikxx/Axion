-- Conversation sync for the web chat app.
-- One row per conversation; messages stored as a JSON array blob.
CREATE TABLE IF NOT EXISTS chats (
  id       TEXT PRIMARY KEY,
  user_id  INTEGER NOT NULL,
  title    TEXT,
  messages TEXT,            -- JSON array of { role, content }
  updated  INTEGER,         -- epoch ms, for sort + last-write-wins
  created  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chats_user ON chats (user_id, updated DESC);
