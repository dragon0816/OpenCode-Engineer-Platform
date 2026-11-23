CREATE TABLE installed_skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  bundled INTEGER NOT NULL CHECK(bundled IN (0,1)),
  instructions TEXT NOT NULL,
  files TEXT NOT NULL
) STRICT;
CREATE TABLE capability_defaults (
  name TEXT PRIMARY KEY
) STRICT;
CREATE TABLE imported_workflows (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL
) STRICT;
CREATE TABLE workspace_mcp_overrides (
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  PRIMARY KEY(workspace_id,server_id)
) STRICT;
