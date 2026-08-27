-- Installation-wide authorization roles for centrally managed capabilities.
--
-- `member` can use shared capabilities, `editor` can manage the Skills/MCP
-- catalogue, and `admin` can also manage platform roles and security settings.
ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'member'
  CHECK(platform_role IN ('member', 'editor', 'admin'));

CREATE INDEX idx_users_platform_role ON users(platform_role);
