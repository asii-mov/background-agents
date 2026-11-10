-- Technology standards on the approved-components catalogue: capability
-- categories, a graded stance (preferred / allowed / denied) and detection
-- signals per component, a per-repository facts inventory reported by
-- sandboxes, governance permissions, and the shipped default policy.
--
-- approved_components is REBUILT, not altered: its `kind` CHECK must widen to
-- 'language', 'tool' and 'data_store' (TypeScript, Bun and D1 are not
-- artifacts), and SQLite cannot alter a CHECK in place.
-- approved_component_consumers references it with RESTRICT, so this follows
-- 0031's recipe: stage the child, drop it, rebuild the parent, recreate and
-- repopulate the child. Every id is kept, and no statement ever leaves a
-- dangling reference, so the migration needs no foreign-key pragma. Comments
-- stay on their own lines so the migration splitter treats each statement cleanly.

CREATE TABLE component_categories (
  id                TEXT PRIMARY KEY
                    CHECK (length(id) BETWEEN 2 AND 64
                           AND id NOT GLOB '*[^a-z0-9-]*'
                           AND id NOT GLOB '-*' AND id NOT GLOB '*-' AND id NOT GLOB '*--*'),
  revision          INTEGER NOT NULL DEFAULT 1,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  enforcement       TEXT NOT NULL DEFAULT 'advise' CHECK (enforcement IN ('advise', 'block')),
  source_kind       TEXT NOT NULL DEFAULT 'app' CHECK (source_kind IN ('app', 'git')),
  source_path       TEXT,
  source_commit_sha TEXT,
  created_by        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_component_categories_name ON component_categories (lower(name));

-- 1) Stage the child.
CREATE TABLE _bak_component_consumers AS SELECT * FROM approved_component_consumers;
DROP TABLE approved_component_consumers;

-- 2) Rebuild the parent with the new columns and table-level invariants.
CREATE TABLE approved_components_new (
  id                TEXT PRIMARY KEY,
  revision          INTEGER NOT NULL DEFAULT 1,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('library', 'service', 'template', 'snippet', 'language', 'tool', 'data_store')),
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
  category_id       TEXT REFERENCES component_categories(id) ON DELETE RESTRICT,
  stance            TEXT NOT NULL DEFAULT 'allowed'
                    CHECK (stance IN ('preferred', 'allowed', 'denied')),
  source_kind       TEXT NOT NULL DEFAULT 'app' CHECK (source_kind IN ('app', 'git')),
  source_path       TEXT,
  source_commit_sha TEXT,
  created_by        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- Preferred and denied are policy grades: they need a category and cannot be
  -- deprecated (a deprecated standard or a deprecated denial means nothing).
  CHECK (stance = 'allowed' OR (category_id IS NOT NULL AND lifecycle <> 'deprecated'))
);

INSERT INTO approved_components_new (
  id, revision, name, kind, description, owner, locator, version, integrity, source_url,
  documentation_url, usage, lifecycle, repo_scope, environment_scope, enabled,
  category_id, stance, source_kind, source_path, source_commit_sha,
  created_by, updated_by, created_at, updated_at
)
SELECT id, revision, name, kind, description, owner, locator, version, integrity, source_url,
       documentation_url, usage, lifecycle, repo_scope, environment_scope, enabled,
       NULL, 'allowed', 'app', NULL, NULL,
       created_by, updated_by, created_at, updated_at
FROM approved_components;

DROP TABLE approved_components;
ALTER TABLE approved_components_new RENAME TO approved_components;

CREATE UNIQUE INDEX idx_approved_components_name ON approved_components (lower(name));
CREATE INDEX idx_approved_components_lifecycle ON approved_components (enabled, lifecycle, name);
CREATE INDEX idx_approved_components_category
  ON approved_components (category_id, stance, enabled, lifecycle);
CREATE INDEX idx_approved_components_source ON approved_components (source_kind, source_path);
-- One standard per category. Drafts (development) and disabled entries may
-- coexist, so a replacement standard can be staged before the switch.
CREATE UNIQUE INDEX idx_approved_components_one_preferred
  ON approved_components (category_id)
  WHERE stance = 'preferred' AND enabled = 1 AND lifecycle = 'approved';

-- 3) Recreate the child verbatim and repopulate it.
CREATE TABLE approved_component_consumers (
  component_id       TEXT NOT NULL REFERENCES approved_components(id) ON DELETE RESTRICT,
  component_revision INTEGER NOT NULL,
  component_version  TEXT,
  repo_owner         TEXT NOT NULL,
  repo_name          TEXT NOT NULL,
  -- Retain the declaring session as provenance even after the ephemeral
  -- session row is deleted, because consumer inventory must outlive agent sessions.
  session_id         TEXT NOT NULL,
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  PRIMARY KEY (component_id, repo_owner, repo_name)
);
INSERT INTO approved_component_consumers SELECT * FROM _bak_component_consumers;
DROP TABLE _bak_component_consumers;
CREATE INDEX idx_approved_component_consumers_repo
  ON approved_component_consumers (repo_owner, repo_name, component_id);

-- Detection signals. One component owns each signal, so a fact maps to at most
-- one verdict. `ecosystem` is '' for file, source and manifest signals (keeps
-- the key total) and is validated by the shared STACK_ECOSYSTEMS list rather
-- than a CHECK, so a new ecosystem needs no rebuild. `value` is a normalized
-- package name or npm '@scope/*', a basename glob using only * and ?, a '.ext',
-- or a data store kind declared in openinspect.app.json.
CREATE TABLE approved_component_signals (
  kind         TEXT NOT NULL CHECK (kind IN ('package', 'file', 'source', 'manifest')),
  ecosystem    TEXT NOT NULL DEFAULT '',
  value        TEXT NOT NULL,
  component_id TEXT NOT NULL REFERENCES approved_components(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, ecosystem, value),
  CHECK ((kind = 'package') = (ecosystem <> ''))
);
CREATE INDEX idx_approved_component_signals_component ON approved_component_signals (component_id);

-- Latest snapshot per (repository, ref). Baselines (base branch at session
-- start) are the repository's real state, and pushes are agent branches in
-- flight. Repository identity is stored lowercased. session_id is provenance only.
CREATE TABLE repository_stack_observations (
  repo_owner       TEXT NOT NULL,
  repo_name        TEXT NOT NULL,
  ref_name         TEXT NOT NULL,
  commit_sha       TEXT NOT NULL
                   CHECK (length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('baseline', 'push')),
  complete         INTEGER NOT NULL CHECK (complete IN (0, 1)),
  policy_digest    TEXT,
  session_id       TEXT NOT NULL,
  observed_at      INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, ref_name)
);
CREATE INDEX idx_repository_stack_observations_kind
  ON repository_stack_observations (observation_kind, observed_at);

-- Raw facts in the same (kind, ecosystem, value) shape as signals, so read-time
-- matching compares like with like. `location` is the manifest path (package),
-- the file path (file and manifest) or '' (source aggregate). A derived file
-- (uv export output beside uv.lock) is stored but never matched.
CREATE TABLE repository_stack_facts (
  repo_owner       TEXT NOT NULL,
  repo_name        TEXT NOT NULL,
  ref_name         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('package', 'file', 'source', 'manifest')),
  ecosystem        TEXT NOT NULL DEFAULT '',
  value            TEXT NOT NULL,
  location         TEXT NOT NULL DEFAULT '',
  dependency_scope TEXT
                   CHECK (dependency_scope IS NULL
                          OR dependency_scope IN ('runtime', 'dev', 'peer', 'optional', 'transitive')),
  declared_range   TEXT,
  resolved_version TEXT,
  file_count       INTEGER CHECK (file_count IS NULL OR file_count > 0),
  derived          INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0, 1)),
  PRIMARY KEY (repo_owner, repo_name, ref_name, kind, ecosystem, value, location),
  FOREIGN KEY (repo_owner, repo_name, ref_name)
    REFERENCES repository_stack_observations (repo_owner, repo_name, ref_name) ON DELETE CASCADE,
  CHECK ((kind = 'package') = (dependency_scope IS NOT NULL)),
  CHECK ((kind = 'source') = (file_count IS NOT NULL)),
  CHECK (kind = 'file' OR derived = 0)
);
CREATE INDEX idx_repository_stack_facts_value ON repository_stack_facts (kind, ecosystem, value);

-- Governance permissions. Owner and Administrator receive them from
-- permissionsForBuiltInRole (code). Member and Viewer do not.
INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_fork_catalog_editor', 'governance.read'),
  ('role_fork_catalog_editor', 'governance.manage');

-- ---------------------------------------------------------------------------
-- Shipped default policy, the one definition of the defaults. These are
-- ordinary app rows: admins edit or disable them, or a Git catalogue replaces
-- them. created_at 0 and created_by 'system' mark seed provenance.
-- ---------------------------------------------------------------------------
INSERT INTO component_categories (id, name, description, enforcement, created_by, updated_by, created_at, updated_at) VALUES
  ('language', 'Language', 'Source language for JavaScript-ecosystem code: browser apps, Workers, scripts and tooling.', 'advise', 'system', 'system', 0, 0),
  ('js-toolchain', 'JavaScript toolchain', 'Installing packages, running scripts and building JavaScript or TypeScript projects. Deployed apps run on the Cloudflare Workers runtime, so this governs install and build, not production.', 'advise', 'system', 'system', 0, 0),
  ('python-tooling', 'Python tooling', 'Environments, dependencies and lockfiles for Python projects.', 'advise', 'system', 'system', 0, 0),
  ('web-frontend', 'Web frontend', 'Anything rendered in a browser: pages, dashboards, internal tools.', 'block', 'system', 'system', 0, 0),
  ('app-data-store', 'App data stores', 'Where internal apps keep persistent data. Declared in openinspect.app.json, then provisioned and bound by the platform.', 'block', 'system', 'system', 0, 0);

INSERT INTO approved_components (
  id, name, kind, category_id, stance, description, owner, locator, documentation_url, usage,
  lifecycle, enabled, source_kind, created_by, updated_by, created_at, updated_at
) VALUES
  ('component_seed_typescript', 'TypeScript', 'language', 'language', 'preferred',
   'Typed superset of JavaScript.', 'platform-engineering',
   'https://www.typescriptlang.org', 'https://www.typescriptlang.org',
   'Write new code in TypeScript with strict mode and a tsconfig.json. Keep an existing JavaScript codebase in JavaScript unless the user asks to migrate.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_javascript', 'JavaScript', 'language', 'language', 'allowed',
   'The language of the web platform.', 'platform-engineering',
   'https://developer.mozilla.org/docs/Web/JavaScript', 'https://developer.mozilla.org/docs/Web/JavaScript',
   'Acceptable where a repository already uses it or the user asks for it.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_bun', 'Bun', 'tool', 'js-toolchain', 'preferred',
   'Package manager, script runner and bundler.', 'platform-engineering',
   'https://bun.sh', 'https://bun.sh',
   'Use bun install, bun run and bun build, and commit bun.lock. Deployed apps run on the Cloudflare Workers runtime: do not use Bun runtime APIs (Bun.serve, Bun.file, bun:sqlite) in deployed code. Keep an existing repository''s package manager unless asked to migrate, and never mix lockfiles.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_npm', 'npm', 'tool', 'js-toolchain', 'allowed',
   'The Node.js package manager.', 'platform-engineering',
   'https://docs.npmjs.com', 'https://docs.npmjs.com',
   'Acceptable where a repository already uses it or the user asks for it. Commit package-lock.json.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_yarn', 'Yarn', 'tool', 'js-toolchain', 'allowed',
   'Alternative JavaScript package manager.', 'platform-engineering',
   'https://yarnpkg.com', 'https://yarnpkg.com',
   'Acceptable where a repository already uses it or the user asks for it. Commit yarn.lock.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_pnpm', 'pnpm', 'tool', 'js-toolchain', 'allowed',
   'Alternative JavaScript package manager.', 'platform-engineering',
   'https://pnpm.io', 'https://pnpm.io',
   'Acceptable where a repository already uses it or the user asks for it. Commit pnpm-lock.yaml.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_node', 'Node.js', 'tool', 'js-toolchain', 'allowed',
   'JavaScript runtime for scripts and tooling.', 'platform-engineering',
   'https://nodejs.org', 'https://nodejs.org',
   'Acceptable where a repository already uses it or the user asks for it.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_uv', 'uv', 'tool', 'python-tooling', 'preferred',
   'Python package and project manager.', 'platform-engineering',
   'https://docs.astral.sh/uv', 'https://docs.astral.sh/uv',
   'Use uv init, uv add and uv run, and commit uv.lock. Do not create requirements.txt, Pipfile or poetry.lock in new projects. Keep an existing repository''s tool unless asked to migrate.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_pip', 'pip', 'tool', 'python-tooling', 'allowed',
   'The Python package installer.', 'platform-engineering',
   'https://pip.pypa.io', 'https://pip.pypa.io',
   'Acceptable where a repository already uses it or the user asks for it.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_poetry', 'Poetry', 'tool', 'python-tooling', 'allowed',
   'Python dependency manager and packager.', 'platform-engineering',
   'https://python-poetry.org', 'https://python-poetry.org',
   'Acceptable where a repository already uses it or the user asks for it.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_pipenv', 'Pipenv', 'tool', 'python-tooling', 'allowed',
   'Python virtual environment and dependency manager.', 'platform-engineering',
   'https://pipenv.pypa.io', 'https://pipenv.pypa.io',
   'Acceptable where a repository already uses it or the user asks for it.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_conda', 'conda', 'tool', 'python-tooling', 'allowed',
   'Cross-language package and environment manager.', 'platform-engineering',
   'https://docs.conda.io', 'https://docs.conda.io',
   'Acceptable where a repository already uses it or the user asks for it.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_svelte', 'Svelte', 'library', 'web-frontend', 'preferred',
   'Component framework for browser UI.', 'platform-engineering',
   'https://svelte.dev', 'https://svelte.dev',
   'Build browser UI with Svelte 5 and SvelteKit using adapter-cloudflare.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_react', 'React', 'library', 'web-frontend', 'denied',
   'Component library for browser UI.', 'platform-engineering',
   'https://react.dev', 'https://react.dev',
   'Not an organization standard for browser UI. Use Svelte instead.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_next', 'Next.js', 'library', 'web-frontend', 'denied',
   'React framework for web applications.', 'platform-engineering',
   'https://nextjs.org', 'https://nextjs.org',
   'Not an organization standard for browser UI. Use SvelteKit instead.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_d1', 'D1 (SQLite)', 'data_store', 'app-data-store', 'preferred',
   'Serverless SQL database for app records.', 'platform-engineering',
   'd1', 'https://developers.cloudflare.com/d1',
   'Records. Schema lives in numbered files under migrations/, and a file is never edited after it has deployed. Query only through prepare(...).bind(...).',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_kv', 'Workers KV', 'data_store', 'app-data-store', 'allowed',
   'Globally replicated key-value store.', 'platform-engineering',
   'kv', 'https://developers.cloudflare.com/kv',
   'Caches and small ephemeral state only, not records.',
   'approved', 1, 'app', 'system', 'system', 0, 0),
  ('component_seed_r2', 'R2', 'data_store', 'app-data-store', 'allowed',
   'Object storage for files.', 'platform-engineering',
   'r2', 'https://developers.cloudflare.com/r2',
   'Private files served through the app. Never public.',
   'approved', 1, 'app', 'system', 'system', 0, 0);

INSERT INTO approved_component_signals (kind, ecosystem, value, component_id) VALUES
  ('file', '', 'tsconfig.json', 'component_seed_typescript'),
  ('source', '', '.ts', 'component_seed_typescript'),
  ('source', '', '.tsx', 'component_seed_typescript'),
  ('source', '', '.mts', 'component_seed_typescript'),
  ('source', '', '.cts', 'component_seed_typescript'),
  ('file', '', 'jsconfig.json', 'component_seed_javascript'),
  ('source', '', '.js', 'component_seed_javascript'),
  ('source', '', '.jsx', 'component_seed_javascript'),
  ('source', '', '.mjs', 'component_seed_javascript'),
  ('source', '', '.cjs', 'component_seed_javascript'),
  ('file', '', 'bun.lock', 'component_seed_bun'),
  ('file', '', 'bun.lockb', 'component_seed_bun'),
  ('file', '', 'bunfig.toml', 'component_seed_bun'),
  ('file', '', 'package-lock.json', 'component_seed_npm'),
  ('file', '', 'npm-shrinkwrap.json', 'component_seed_npm'),
  ('file', '', 'yarn.lock', 'component_seed_yarn'),
  ('file', '', '.yarnrc.yml', 'component_seed_yarn'),
  ('file', '', 'pnpm-lock.yaml', 'component_seed_pnpm'),
  ('file', '', 'pnpm-workspace.yaml', 'component_seed_pnpm'),
  ('file', '', '.nvmrc', 'component_seed_node'),
  ('file', '', '.node-version', 'component_seed_node'),
  ('file', '', 'uv.lock', 'component_seed_uv'),
  ('file', '', 'requirements*.txt', 'component_seed_pip'),
  ('file', '', 'constraints*.txt', 'component_seed_pip'),
  ('file', '', 'poetry.lock', 'component_seed_poetry'),
  ('file', '', 'Pipfile', 'component_seed_pipenv'),
  ('file', '', 'Pipfile.lock', 'component_seed_pipenv'),
  ('file', '', 'environment.yml', 'component_seed_conda'),
  ('file', '', 'environment.yaml', 'component_seed_conda'),
  ('file', '', 'conda-lock.yml', 'component_seed_conda'),
  ('package', 'npm', 'svelte', 'component_seed_svelte'),
  ('package', 'npm', '@sveltejs/kit', 'component_seed_svelte'),
  ('source', '', '.svelte', 'component_seed_svelte'),
  ('package', 'npm', 'react', 'component_seed_react'),
  ('package', 'npm', 'react-dom', 'component_seed_react'),
  ('package', 'npm', 'next', 'component_seed_next'),
  ('manifest', '', 'd1', 'component_seed_d1'),
  ('manifest', '', 'kv', 'component_seed_kv'),
  ('manifest', '', 'r2', 'component_seed_r2');
