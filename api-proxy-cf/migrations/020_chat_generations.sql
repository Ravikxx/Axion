-- Server-owned web-chat generations. A Durable Object runs the model request
-- after the browser request has returned, while D1 exposes durable status and
-- the final assistant message to every tab/device.

ALTER TABLE chats ADD COLUMN active_generation_id TEXT;

CREATE TABLE chat_generations (
  id             TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL,
  user_id        INTEGER NOT NULL,
  status         TEXT NOT NULL,
  model          TEXT NOT NULL,
  error          TEXT,
  created        INTEGER NOT NULL,
  started        INTEGER,
  completed      INTEGER
);

CREATE INDEX idx_chat_generations_chat
  ON chat_generations (chat_id, created DESC);

CREATE INDEX idx_chat_generations_user_status
  ON chat_generations (user_id, status, created DESC);
