-- Centrally owned reusable security and architecture primitives, plus a
-- revision-aware consumer inventory for update and deprecation campaigns.

CREATE TABLE approved_components (
  id                TEXT PRIMARY KEY,
  revision          INTEGER NOT NULL DEFAULT 1,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('library', 'service', 'template', 'snippet')),
  description       TEXT NOT NULL,
  owner             TEXT NOT NULL,
  locator           TEXT NOT NULL,
  version           TEXT,
  integrity         TEXT,
  source_url        TEXT,
  documentation_url TEXT,
  usage             TEXT NOT NULL,
  lifecycle         TEXT NOT NULL DEFAULT 'development'
                    CHECK (lifecycle IN ('development', 'approved', 'deprecated')),
  repo_scope        TEXT,
  environment_scope TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_approved_components_name ON approved_components (lower(name));
CREATE INDEX idx_approved_components_lifecycle
  ON approved_components (enabled, lifecycle, name);

CREATE TABLE approved_component_consumers (
  component_id       TEXT NOT NULL REFERENCES approved_components(id) ON DELETE RESTRICT,
  component_revision INTEGER NOT NULL,
  component_version  TEXT,
  repo_owner         TEXT NOT NULL,
  repo_name          TEXT NOT NULL,
  -- Retain the declaring session as provenance even after the ephemeral
  -- session row is deleted; consumer inventory must outlive agent sessions.
  session_id         TEXT NOT NULL,
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  PRIMARY KEY (component_id, repo_owner, repo_name)
);

CREATE INDEX idx_approved_component_consumers_repo
  ON approved_component_consumers (repo_owner, repo_name, component_id);
