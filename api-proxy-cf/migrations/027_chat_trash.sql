-- Soft delete. A "deleted" chat just gets deleted_at set; DELETE /chats/:id
-- no longer removes the row immediately, so it can be restored, and so the
-- 30-day retention purge (see the hourly scheduled handler) has something
-- to act on.
ALTER TABLE chats ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_chats_deleted ON chats (user_id, deleted_at);
