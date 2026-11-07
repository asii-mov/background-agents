-- Hardened data for agent-deployed apps. The control plane's app-data module is the only writer.
-- Invariants held here rather than in code:
--   one live resource per (app, stage, binding)             uq_app_data_resources_live
--   one Cloudflare resource name per row not yet purged     uq_app_data_resources_provider_name
--   retired rows carry retired_at and purge_after           CHECK
--   an applied migration carries applied_at                 CHECK
--   a preview never reads a production secret               stage is part of the secrets key
-- Comments stay on their own lines so the migration splitter treats each statement cleanly.

CREATE TABLE app_data_profiles (
  app_name              TEXT PRIMARY KEY REFERENCES apps(name) ON DELETE RESTRICT,
  classification        TEXT NOT NULL CHECK (classification IN ('internal', 'confidential', 'restricted')),
  -- 'admin' locks the label: a manifest can no longer change it.
  classification_source TEXT NOT NULL CHECK (classification_source IN ('manifest', 'admin')),
  -- Secret names the last deployed manifest declared, as a JSON array. Names only, never values.
  declared_secrets_json TEXT NOT NULL DEFAULT '[]',
  updated_by            TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- One row per provisioned resource. Rows are never deleted: retired, then purged, then kept as
-- inventory history.
CREATE TABLE app_data_resources (
  id                      TEXT PRIMARY KEY,
  app_name                TEXT NOT NULL REFERENCES apps(name) ON DELETE RESTRICT,
  stage                   TEXT NOT NULL CHECK (stage IN ('production', 'preview')),
  binding_name            TEXT NOT NULL CHECK (length(binding_name) BETWEEN 1 AND 32),
  kind                    TEXT NOT NULL CHECK (kind IN ('d1', 'kv', 'r2')),
  -- The Cloudflare-side name: the adoption key that makes provisioning idempotent.
  provider_name           TEXT NOT NULL CHECK (provider_name LIKE 'app-%' AND length(provider_name) <= 63),
  -- D1 uuid, KV namespace id or R2 bucket name. NULL only while provisioning.
  provider_ref            TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'retired', 'purging', 'purged')),
  size_bytes              INTEGER,
  retired_at              INTEGER,
  retire_reason           TEXT CHECK (retire_reason IN ('takedown', 'binding_removed')),
  purge_after             INTEGER,
  purged_at               INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  CHECK ((status IN ('retired', 'purging', 'purged')) = (retired_at IS NOT NULL)),
  CHECK ((retired_at IS NULL) = (purge_after IS NULL)),
  CHECK ((retired_at IS NULL) = (retire_reason IS NULL)),
  CHECK ((status = 'provisioning') = (provider_ref IS NULL)),
  CHECK ((status = 'purged') = (purged_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_app_data_resources_live
  ON app_data_resources (app_name, stage, binding_name)
  WHERE status IN ('provisioning', 'ready');

CREATE UNIQUE INDEX uq_app_data_resources_provider_name
  ON app_data_resources (provider_name)
  WHERE status <> 'purged';

-- The purge sweep's scan, and the per-app reads.
CREATE INDEX idx_app_data_resources_purge ON app_data_resources (status, purge_after);
CREATE INDEX idx_app_data_resources_app ON app_data_resources (app_name, stage, status);

-- Schema history per D1 resource: one row per migration file, carrying the exact bytes (sha256)
-- that were blocked, approved, applied or failed.
CREATE TABLE app_data_migrations (
  resource_id     TEXT NOT NULL REFERENCES app_data_resources(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  sha256          TEXT NOT NULL CHECK (length(sha256) = 64),
  status          TEXT NOT NULL CHECK (status IN ('blocked', 'approved', 'applying', 'applied', 'failed')),
  classification  TEXT NOT NULL CHECK (classification IN ('additive', 'destructive')),
  -- The statements an approver reviews, as a JSON array. DDL and DML text only, never row data.
  statements_json TEXT NOT NULL DEFAULT '[]',
  -- D1 Time Travel bookmark taken before the file was sent (or when it was blocked): the undo handle.
  bookmark_before TEXT,
  approved_by     TEXT,
  approved_at     INTEGER,
  applied_at      INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (resource_id, name),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  CHECK (status NOT IN ('applying', 'applied') OR bookmark_before IS NOT NULL)
);

-- App secrets per stage, encrypted with REPO_SECRETS_ENCRYPTION_KEY like every scoped secret.
-- Write-only through the API; values reach a Worker only as secret_text bindings at publish.
CREATE TABLE app_data_secrets (
  app_name        TEXT NOT NULL REFERENCES apps(name) ON DELETE RESTRICT,
  stage           TEXT NOT NULL CHECK (stage IN ('production', 'preview')),
  key             TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (app_name, stage, key)
);

-- Append-only ledger of every data operation. It is the data audit log: no second stream.
CREATE TABLE app_data_operations (
  id               TEXT PRIMARY KEY,
  app_name         TEXT NOT NULL,
  stage            TEXT CHECK (stage IN ('production', 'preview')),
  resource_id      TEXT,
  binding_name     TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('provision', 'reinstate', 'retire', 'purge', 'migrate',
                                                 'approve_migration', 'secret_set', 'secret_delete',
                                                 'restore', 'classify', 'policy_block')),
  result           TEXT NOT NULL CHECK (result IN ('applied', 'blocked', 'failed')),
  actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('session', 'user', 'system')),
  actor_user_id    TEXT,
  actor_session_id TEXT,
  actor_job        TEXT,
  request_id       TEXT,
  -- Secret-free structured detail: migration name, reason code, bookmarks, secret names.
  detail_json      TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL,
  CHECK ((actor_kind = 'system') = (actor_job IS NOT NULL)),
  CHECK (actor_kind <> 'session' OR actor_session_id IS NOT NULL),
  CHECK (actor_kind <> 'user' OR actor_user_id IS NOT NULL)
);

CREATE INDEX idx_app_data_operations_app ON app_data_operations (app_name, occurred_at DESC, id DESC);

-- The app-data conformance checker runs as a platform security pipeline: the same stage,
-- remediation loop and blocking semantics as every AppSec check, after each turn and before each
-- push, for every repository. It exits 0 in a checkout without openinspect.app.json.
INSERT INTO security_pipelines
  (id, revision, name, commands_json, repo_scope, environment_scope, enabled, blocking,
   max_remediation_attempts, created_by, updated_by, created_at, updated_at)
VALUES
  ('secpipe_platform_app_data_conformance', 1, 'Platform: app data conformance',
   '[{"name":"app-data-conformance","command":["python","-m","sandbox_runtime.conformance","app-data"],"timeoutSeconds":120}]',
   NULL, NULL, 1, 1, 2, 'system', 'system', 0, 0);
