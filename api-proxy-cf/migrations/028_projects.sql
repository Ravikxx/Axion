-- Projects group chats together. A chat belongs to at most one project
-- (project_id is nullable — most chats stay unfiled). Deleting a project
-- does not delete its chats; they just fall back to unfiled.
CREATE TABLE projects (
  id      TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name    TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE INDEX idx_projects_user ON projects (user_id, updated DESC);

ALTER TABLE chats ADD COLUMN project_id TEXT;
CREATE INDEX idx_chats_project ON chats (project_id);
