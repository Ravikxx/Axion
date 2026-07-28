-- Artifacts: a persistent library of Axion-created outputs (documents, code
-- previews, charts, images, generated files). Each artifact has a chain of
-- revisions; the artifact row itself just points at the latest one so
-- listing doesn't require pulling revision content.
CREATE TABLE artifacts (
  id                  TEXT PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  project_id          TEXT,
  chat_id             TEXT,
  title               TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'text',
  language            TEXT,
  latest_revision_id  TEXT,
  created             INTEGER NOT NULL,
  updated             INTEGER NOT NULL
);

CREATE INDEX idx_artifacts_user ON artifacts (user_id, updated DESC);
CREATE INDEX idx_artifacts_project ON artifacts (project_id);
CREATE INDEX idx_artifacts_chat ON artifacts (chat_id);

CREATE TABLE artifact_revisions (
  id           TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL,
  content      TEXT,
  created      INTEGER NOT NULL
);

CREATE INDEX idx_artifact_revisions_artifact ON artifact_revisions (artifact_id, created DESC);
