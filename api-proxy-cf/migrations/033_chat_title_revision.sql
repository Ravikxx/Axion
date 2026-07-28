-- Optimistic concurrency for chat titles. A client that read title_rev N and
-- sends expected_title_rev=N gets a 409 (not a silent overwrite) if someone
-- else renamed the chat in between. Existing rows default to 0 so the very
-- first revision after this migration is 1.
ALTER TABLE chats ADD COLUMN title_rev INTEGER NOT NULL DEFAULT 0;
