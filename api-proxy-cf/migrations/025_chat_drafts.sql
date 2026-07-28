-- Per-chat unsent draft, so an in-progress message survives closing the tab
-- or switching to another chat and back.
ALTER TABLE chats ADD COLUMN draft TEXT;
ALTER TABLE chats ADD COLUMN draft_updated_at INTEGER;
