-- Governance metadata and environment assignment for centrally managed MCPs.
-- Existing local commands require an explicit review before they can run under
-- the new pinned-package rule; remote servers retain their previous behavior.

ALTER TABLE mcp_servers
  ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'approved'
    CHECK (lifecycle IN ('development', 'approved', 'deprecated'));

ALTER TABLE mcp_servers ADD COLUMN environment_scope TEXT;
ALTER TABLE mcp_servers ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system';
ALTER TABLE mcp_servers ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'system';

UPDATE mcp_servers SET lifecycle = 'development' WHERE type = 'local';

CREATE INDEX idx_mcp_servers_lifecycle_enabled
  ON mcp_servers (lifecycle, enabled, name);
