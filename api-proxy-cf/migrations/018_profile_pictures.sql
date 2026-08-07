-- Profile-picture bytes live in R2. D1 stores only the current object key and
-- the cache-busting version exposed to clients.
ALTER TABLE users ADD COLUMN avatar_key TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER DEFAULT NULL;
