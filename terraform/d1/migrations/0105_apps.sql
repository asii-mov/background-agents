-- Agent-deployed internal apps: ownership, status and a per-deploy ledger.
-- No Cloudflare id is needed to find an app's resources: the broker derives
-- the script, hostname and Access application from `name`. The ids stored
-- here (cf_version_id, access_aud) are informational. Names are never
-- released in v1, so an old bookmark can never land on someone else's app.
-- Comments stay on their own lines so the migration splitter treats each
-- statement cleanly.

CREATE TABLE apps (
  -- One DNS label (APP_NAME_PATTERN in @open-inspect/shared/apps).
  name              TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  owner_team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'live', 'failed', 'taken_down')),
  -- Reported by the broker on the first successful deploy; NULL until then.
  backend           TEXT CHECK (backend IN ('workers', 'dispatch-namespace')),
  access_aud        TEXT,
  -- The live deployment's version; 0 until the first successful deploy.
  version           INTEGER NOT NULL DEFAULT 0,
  has_worker        INTEGER NOT NULL DEFAULT 0 CHECK (has_worker IN (0, 1)),
  asset_count       INTEGER NOT NULL DEFAULT 0,
  bundle_bytes      INTEGER NOT NULL DEFAULT 0,
  cf_version_id     TEXT,
  last_session_id   TEXT,
  -- May contain '/' (nested namespaces).
  last_repo_owner   TEXT,
  last_repo_name    TEXT,
  last_error_reason TEXT,
  last_deployed_at  INTEGER,
  hold_kind         TEXT CHECK (hold_kind IN ('owner_unpublished', 'admin_takedown')),
  hold_at           INTEGER,
  hold_by           TEXT,
  hold_reason       TEXT,
  -- NULL while Cloudflare and data cleanup is incomplete; re-running takedown finishes it.
  sweep_completed_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK ((status = 'taken_down') = (hold_kind IS NOT NULL)),
  CHECK ((hold_kind IS NULL) = (hold_at IS NULL AND hold_by IS NULL AND hold_reason IS NULL)),
  CHECK (hold_kind IS NOT NULL OR sweep_completed_at IS NULL),
  CHECK (status <> 'live' OR (cf_version_id IS NOT NULL AND last_deployed_at IS NOT NULL AND backend IS NOT NULL)),
  CHECK ((last_repo_owner IS NULL) = (last_repo_name IS NULL))
);
CREATE INDEX idx_apps_owner ON apps (owner_user_id, updated_at DESC);
CREATE INDEX idx_apps_team ON apps (owner_team_id, updated_at DESC) WHERE owner_team_id IS NOT NULL;
CREATE INDEX idx_apps_status ON apps (status, updated_at DESC);

-- One row per deploy attempt: the audit record and the one-live-row invariant.
CREATE TABLE app_deployments (
  id             TEXT PRIMARY KEY,
  app_name       TEXT NOT NULL REFERENCES apps(name) ON DELETE RESTRICT,
  version        INTEGER NOT NULL CHECK (version >= 1),
  status         TEXT NOT NULL CHECK (status IN ('pending', 'live', 'superseded', 'failed', 'taken_down')),
  bundle_sha256  TEXT NOT NULL CHECK (length(bundle_sha256) = 64),
  has_worker     INTEGER NOT NULL CHECK (has_worker IN (0, 1)),
  asset_count    INTEGER NOT NULL CHECK (asset_count >= 0),
  bundle_bytes   INTEGER NOT NULL CHECK (bundle_bytes >= 0),
  cf_version_id  TEXT,
  -- sha256 over bindings, secret names and applied migration hashes.
  data_digest    TEXT,
  session_id     TEXT,
  user_id        TEXT NOT NULL,
  repo_owner     TEXT,
  repo_name      TEXT,
  failure_reason TEXT,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  UNIQUE (app_name, version),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK (status NOT IN ('live', 'superseded', 'taken_down') OR cf_version_id IS NOT NULL),
  CHECK ((status = 'pending') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX uq_app_deployments_one_live ON app_deployments (app_name) WHERE status = 'live';
CREATE UNIQUE INDEX uq_app_deployments_one_pending ON app_deployments (app_name) WHERE status = 'pending';
CREATE INDEX idx_app_deployments_history ON app_deployments (app_name, version DESC);
CREATE INDEX idx_app_deployments_session ON app_deployments (session_id, created_at DESC) WHERE session_id IS NOT NULL;

-- Built-in grants are code (rbac.ts). The fork's catalogue-editor role is a member superset.
INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_fork_catalog_editor', 'apps.read'),
  ('role_fork_catalog_editor', 'apps.deploy'),
  ('role_fork_catalog_editor', 'apps.manage.own');
