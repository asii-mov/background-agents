-- DELTA over stack/candidate-1/sketch/0104_stack_policy.sql. Apply these changes to that file.

-- 1. Kind CHECK widens by one more value:
--    CHECK (kind IN ('library','service','template','snippet','language','tool','data_store'))

-- 2. Signal kinds gain 'manifest'; ecosystem stays '' for it:
--    kind TEXT NOT NULL CHECK (kind IN ('package','file','source','manifest'))
--    (facts table: same CHECK; `location` for manifest facts = the openinspect.app.json path)

-- 3. Facts table gains a derived flag for file facts:
--    derived INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0,1)),
--    CHECK (kind = 'file' OR derived = 0)

-- 4. Seed: web-frontend enforcement is 'block' on day one (delta semantics protect legacy repos):
--    ('web-frontend', 'Web frontend', 'Anything rendered in a browser: pages, dashboards, internal tools.', 'block', ...)

-- 5. Seed: fifth category and the data-store components (same graded model; manifest signals):
INSERT INTO component_categories (id, name, description, enforcement, created_by, updated_by, created_at, updated_at) VALUES
  ('app-data-store', 'App data stores', 'Where internal apps keep persistent data. Declared in openinspect.app.json; the platform provisions and binds it.', 'block', 'system', 'system', 0, 0);

-- id, name, kind, category_id, stance, locator, documentation_url, usage
--   component_seed_d1  'D1 (SQLite)'  data_store  app-data-store  preferred  d1  https://developers.cloudflare.com/d1
--       usage: 'Records. Schema lives in numbered files under migrations/; never edit a file after it has deployed. Query only through prepare(...).bind(...).'
--   component_seed_kv  'Workers KV'   data_store  app-data-store  allowed    kv  https://developers.cloudflare.com/kv
--       usage: 'Caches and small ephemeral state only; not records.'
--   component_seed_r2  'R2'           data_store  app-data-store  allowed    r2  https://developers.cloudflare.com/r2
--       usage: 'Private files served through the app. Never public.'
INSERT INTO approved_component_signals (kind, ecosystem, value, component_id) VALUES
  ('manifest', '', 'd1', 'component_seed_d1'),
  ('manifest', '', 'kv', 'component_seed_kv'),
  ('manifest', '', 'r2', 'component_seed_r2');

-- 6. Full INSERT INTO approved_components for all 18 seed rows (15 from candidate 1 + 3 above) with
--    owner 'platform-engineering', lifecycle 'approved', enabled 1, created_by/updated_by 'system',
--    created_at/updated_at 0, source_kind 'app'. (Candidate 1 elided them; write them out.)

-- 7. Permissions (unchanged from candidate 1):
--    INSERT INTO role_permissions VALUES ('role_fork_catalog_editor','governance.read'), ('role_fork_catalog_editor','governance.manage');
