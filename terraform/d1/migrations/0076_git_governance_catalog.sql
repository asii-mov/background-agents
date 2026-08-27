-- Git-backed desired state for managed Skills and MCP servers.
-- Git records policy (including unpinned MCP update policy); D1 records the
-- last validated, exact runtime resolution. Existing app-managed catalogue
-- entries remain supported when Git governance is not configured.

ALTER TABLE skills ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'app';
ALTER TABLE skills ADD COLUMN source_path TEXT;
ALTER TABLE skills ADD COLUMN source_commit_sha TEXT;

ALTER TABLE mcp_servers ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'app';
ALTER TABLE mcp_servers ADD COLUMN source_path TEXT;
ALTER TABLE mcp_servers ADD COLUMN source_commit_sha TEXT;
ALTER TABLE mcp_servers ADD COLUMN update_policy_json TEXT;
ALTER TABLE mcp_servers ADD COLUMN resolved_version TEXT;
ALTER TABLE mcp_servers ADD COLUMN resolved_integrity TEXT;
ALTER TABLE mcp_servers ADD COLUMN artifact_key TEXT;
ALTER TABLE mcp_servers ADD COLUMN artifact_sha256 TEXT;
ALTER TABLE mcp_servers ADD COLUMN artifact_executable TEXT;

CREATE TABLE governance_catalog_state (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_provider    TEXT,
  source_repo_owner  TEXT,
  source_repo_name   TEXT,
  source_ref         TEXT,
  source_path        TEXT,
  active_commit_sha  TEXT,
  last_attempted_at  INTEGER,
  last_succeeded_at  INTEGER,
  last_status        TEXT NOT NULL DEFAULT 'idle'
    CHECK (last_status IN ('idle', 'succeeded', 'failed')),
  last_error         TEXT
);
INSERT INTO governance_catalog_state (singleton) VALUES (1);

-- Immutable MCP runtime definitions. Credentials intentionally remain on the
-- mutable catalogue row so they can rotate without changing a session's code.
CREATE TABLE mcp_catalog_revisions (
  mcp_server_id       TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('local', 'remote')),
  command             TEXT,
  url                 TEXT,
  repo_scope          TEXT,
  environment_scope   TEXT,
  lifecycle           TEXT NOT NULL,
  enabled             INTEGER NOT NULL,
  source_commit_sha   TEXT,
  resolved_version    TEXT,
  resolved_integrity  TEXT,
  artifact_key        TEXT,
  artifact_sha256     TEXT,
  artifact_executable TEXT,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (mcp_server_id, revision),
  FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
  CHECK ((type = 'local' AND command IS NOT NULL) OR (type = 'remote' AND url IS NOT NULL))
);

INSERT INTO mcp_catalog_revisions (
  mcp_server_id, revision, name, type, command, url, repo_scope,
  environment_scope, lifecycle, enabled, source_commit_sha,
  resolved_version, resolved_integrity, artifact_key, artifact_sha256,
  artifact_executable, created_at
)
SELECT id, revision, name, type, command, url, repo_scope,
       environment_scope, lifecycle, enabled, NULL, NULL, NULL, NULL, NULL, NULL, updated_at
FROM mcp_servers;

CREATE TABLE session_mcp_manifests (
  session_id          TEXT PRIMARY KEY,
  catalog_commit_sha  TEXT,
  resolved_at         INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE session_mcp_servers (
  session_id          TEXT NOT NULL,
  position            INTEGER NOT NULL,
  mcp_server_id       TEXT NOT NULL,
  mcp_revision        INTEGER NOT NULL,
  name                TEXT NOT NULL,
  resolved_version    TEXT,
  resolved_integrity  TEXT,
  PRIMARY KEY (session_id, position),
  UNIQUE (session_id, mcp_server_id),
  FOREIGN KEY (session_id) REFERENCES session_mcp_manifests(session_id) ON DELETE CASCADE,
  FOREIGN KEY (mcp_server_id, mcp_revision)
    REFERENCES mcp_catalog_revisions(mcp_server_id, revision) ON DELETE RESTRICT
);

CREATE INDEX idx_skills_source_kind ON skills (source_kind, source_path);
CREATE INDEX idx_mcp_servers_source_kind ON mcp_servers (source_kind, source_path);
