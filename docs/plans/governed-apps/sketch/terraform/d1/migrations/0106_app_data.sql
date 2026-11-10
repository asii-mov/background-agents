-- 0106_app_data.sql (FINAL; from data/fable/sketch/terraform/d1/migrations/0104_app_data.sql with these changes)
--
--  * renumbered 0106; follows 0105_apps.sql
--  * every `app_id TEXT ... REFERENCES apps(id)` becomes `app_name TEXT ... REFERENCES apps(name) ON DELETE RESTRICT`
--  * app_data_resources.kind CHECK: ('d1','kv','r2')        -- no hyperdrive in v1
--  * app_data_operations.kind CHECK: ('provision','reinstate','retire','purge','migrate','approve_migration',
--                                     'secret_set','secret_delete','restore','classify','policy_block')  -- no 'export'
--  * no role_permissions INSERT (data management rides apps.manage.* from 0105)
--  * the `app-data-store` catalogue seed is NOT here (it lives in 0104 with the rest of the seed policy)
--  * keep the seeded platform security pipeline, with the Python entry point that execs Bun:
INSERT INTO security_pipelines
  (id, revision, name, commands_json, repo_scope, environment_scope, enabled, blocking,
   max_remediation_attempts, created_by, updated_by, created_at, updated_at)
VALUES
  ('secpipe_platform_app_data_conformance', 1, 'Platform: app data conformance',
   '[{"name":"app-data-conformance","command":["python","-m","sandbox_runtime.conformance","app-data"],"timeoutSeconds":120}]',
   NULL, NULL, 1, 1, 2, 'system', 'system', 0, 0);
-- Tables (unchanged shape otherwise): app_data_profiles, app_data_resources (+ partial unique indexes
-- uq_app_data_resources_live, uq_app_data_resources_provider_name), app_data_migrations,
-- app_data_secrets (PK app_name, stage, key), app_data_operations.
