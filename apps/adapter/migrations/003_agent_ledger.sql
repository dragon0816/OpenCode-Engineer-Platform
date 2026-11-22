CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('orchestrator', 'specialist')),
  builtin_key TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active', 'archived')),
  name TEXT NOT NULL CHECK(length(name) <= 80),
  introduction TEXT NOT NULL CHECK(length(introduction) <= 500),
  instructions TEXT NOT NULL CHECK(length(instructions) <= 4000),
  avatar BLOB,
  avatar_mime TEXT,
  default_model_id TEXT,
  reply_locale TEXT NOT NULL CHECK(reply_locale IN ('zh-TW', 'en')),
  config_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((avatar IS NULL AND avatar_mime IS NULL) OR
    (avatar IS NOT NULL AND length(avatar) BETWEEN 1 AND 92160 AND
      (avatar_mime IS 'image/png' OR avatar_mime IS 'image/jpeg'))),
  CHECK(
    (id = 'main' AND role = 'orchestrator' AND builtin_key IS 'main' AND state = 'active') OR
    (id = 'bi' AND role = 'specialist' AND builtin_key IS 'bi' AND state = 'active') OR
    (id NOT IN ('main', 'bi') AND role = 'specialist' AND builtin_key IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX agents_single_orchestrator ON agents(role) WHERE role = 'orchestrator';
CREATE TRIGGER agents_keep_builtin BEFORE DELETE ON agents
WHEN OLD.builtin_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Built-in agents cannot be deleted');
END;
CREATE TRIGGER agents_fix_builtin_identity BEFORE UPDATE OF id, role, builtin_key ON agents
WHEN (OLD.builtin_key IS NOT NULL OR NEW.builtin_key IS NOT NULL) AND
  (OLD.id IS NOT NEW.id OR OLD.role IS NOT NEW.role OR OLD.builtin_key IS NOT NEW.builtin_key)
BEGIN
  SELECT RAISE(ABORT, 'Built-in agent identity is fixed');
END;
-- REPLACE can bypass delete triggers when recursive_triggers is off.
CREATE TRIGGER agents_keep_builtin_on_insert BEFORE INSERT ON agents
WHEN NEW.id IN ('main', 'bi') AND EXISTS (SELECT 1 FROM agents WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'Built-in agents cannot be replaced');
END;

CREATE TABLE agent_workspaces (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  layout TEXT NOT NULL CHECK(layout IN ('managed', 'legacy_default', 'legacy_secondary')),
  relative_root TEXT NOT NULL UNIQUE,
  display_name TEXT,
  is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)),
  classification TEXT NOT NULL DEFAULT 'unclassified' CHECK(classification IN ('unclassified', 'public', 'confidential')),
  created_at INTEGER NOT NULL,
  UNIQUE(id, agent_id)
) STRICT;
CREATE UNIQUE INDEX agent_workspaces_one_default ON agent_workspaces(agent_id) WHERE is_default = 1;

CREATE TABLE workspace_read_folders (
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  folder TEXT NOT NULL,
  PRIMARY KEY(workspace_id, folder)
) STRICT;
CREATE TABLE agent_knowledge_reads (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  vault_id TEXT NOT NULL,
  PRIMARY KEY(agent_id, vault_id)
) STRICT;
CREATE TABLE agent_write_targets (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('knowledge', 'bi_intake', 'collection')),
  target_id TEXT NOT NULL,
  write_mode TEXT NOT NULL CHECK(write_mode = 'proposal_only'),
  PRIMARY KEY(agent_id, target_kind, target_id)
) STRICT;
CREATE TABLE agent_capabilities (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'workflow', 'mcp', 'plugin')),
  capability_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  PRIMARY KEY(agent_id, kind, capability_id)
) STRICT;
CREATE TABLE workspace_mcp_grants (
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY(workspace_id, server_id)
) STRICT;
CREATE TABLE agent_trigger_settings (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  message_enabled INTEGER NOT NULL CHECK(message_enabled IN (0, 1))
) STRICT;
CREATE TABLE file_classifications (
  file_kind TEXT NOT NULL CHECK(file_kind IN ('attachment', 'artifact', 'handoff', 'workspace')),
  file_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  sha256 TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'unclassified' CHECK(classification IN ('unclassified', 'public', 'confidential')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(file_kind, file_id, workspace_id, sha256)
) STRICT;
CREATE TABLE delegation_budget_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  delegations_per_message INTEGER NOT NULL DEFAULT 3 CHECK(delegations_per_message > 0),
  execution_ms_per_delegation INTEGER NOT NULL DEFAULT 300000 CHECK(execution_ms_per_delegation > 0),
  model_requests_per_delegation INTEGER NOT NULL DEFAULT 10 CHECK(model_requests_per_delegation > 0),
  tool_calls_per_delegation INTEGER NOT NULL DEFAULT 30 CHECK(tool_calls_per_delegation > 0),
  model_requests_per_message INTEGER NOT NULL DEFAULT 30 CHECK(model_requests_per_message > 0),
  tool_calls_per_message INTEGER NOT NULL DEFAULT 90 CHECK(tool_calls_per_message > 0),
  queue_ms INTEGER NOT NULL DEFAULT 600000 CHECK(queue_ms > 0)
) STRICT;
