-- Sharing. One share row per resource (Only me <-> Anyone with the link is a
-- single toggle, not a list) — resharing an already-shared resource updates
-- this row in place rather than creating a second link.
--
-- Snapshot mode stores its own copy of the content at share time, so it
-- keeps working even if the original chat is later edited or deleted; Live
-- mode stores nothing here and reads the resource fresh on every view.
CREATE TABLE shares (
  id                 TEXT PRIMARY KEY,
  resource_type      TEXT NOT NULL,
  resource_id        TEXT NOT NULL,
  owner_user_id      INTEGER NOT NULL,
  mode               TEXT NOT NULL DEFAULT 'snapshot',
  snapshot_title     TEXT,
  snapshot_messages  TEXT,
  expires_at         INTEGER,
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_shares_resource ON shares (resource_type, resource_id);
CREATE INDEX idx_shares_owner ON shares (owner_user_id);
