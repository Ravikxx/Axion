-- Cloud-task metadata and event history: a place to persist a cloud task's
-- state and its append-only event log. This does not run anything — actually
-- executing a cloud task against a workspace with repository secrets is
-- Increment 11 ("Secretless cloud beta") scope, explicitly deferred and
-- gated on a separate secrets policy decision that has nothing to do with
-- this table. This only tracks state that a future executor would read and
-- write into, same relationship scheduled_definitions has to its own
-- dispatcher.
CREATE TABLE cloud_tasks (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  project_id    TEXT,
  chat_id       TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  error         TEXT,
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL,
  completed     INTEGER
);

CREATE INDEX idx_cloud_tasks_user ON cloud_tasks (user_id, updated DESC);

CREATE TABLE cloud_task_events (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  type          TEXT NOT NULL,
  message       TEXT,
  data          TEXT,
  created       INTEGER NOT NULL
);

CREATE INDEX idx_cloud_task_events_task ON cloud_task_events (task_id, created ASC);
