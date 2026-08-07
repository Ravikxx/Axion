-- Pinned chats. pinned_at orders the pinned section (most recently pinned
-- first) independently of updated, so pinning an old, quiet chat doesn't
-- reshuffle it based on when it was last active.
ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN pinned_at INTEGER;
