CREATE TABLE IF NOT EXISTS agent_model_sources (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(id),
  source TEXT NOT NULL CHECK(source IN ('codex_cli', 'claude_code'))
) STRICT;
