-- Centrally assigned AppSec command pipelines executed inside agent sandboxes.

CREATE TABLE security_pipelines (
  id                       TEXT PRIMARY KEY,
  revision                 INTEGER NOT NULL DEFAULT 1,
  name                     TEXT NOT NULL,
  commands_json            TEXT NOT NULL,
  repo_scope               TEXT,
  environment_scope        TEXT,
  enabled                  INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  blocking                 INTEGER NOT NULL DEFAULT 1 CHECK (blocking IN (0, 1)),
  max_remediation_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_remediation_attempts BETWEEN 0 AND 5),
  created_by               TEXT NOT NULL,
  updated_by               TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_security_pipelines_name ON security_pipelines (lower(name));
CREATE INDEX idx_security_pipelines_enabled ON security_pipelines (enabled, name);
