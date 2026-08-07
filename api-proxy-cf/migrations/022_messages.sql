-- Individual chat messages, replacing the JSON blob on chats.messages.
--
-- The blob forced every append (including the server-owned generation
-- commit in chatGeneration.js) to read-modify-write the whole conversation,
-- which is how a client's full-chat PUT could race the Durable Object's
-- commit and silently drop the assistant's reply. Real rows make append
-- idempotent per-row instead.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT,
  tool_calls    TEXT,     -- JSON array; present only on tool-calling assistant replies
  tool_call_id  TEXT,     -- present only on {role:'tool'} results
  generation_id TEXT,     -- set on assistant replies produced by chat_generations; makes append idempotent across alarm retries
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE UNIQUE INDEX idx_messages_chat_seq ON messages (chat_id, seq);
CREATE UNIQUE INDEX idx_messages_generation ON messages (generation_id) WHERE generation_id IS NOT NULL;
