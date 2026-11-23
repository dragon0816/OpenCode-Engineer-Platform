CREATE TABLE external_helper_settings (
  provider TEXT PRIMARY KEY CHECK(provider IN ('claude_code','codex_cli')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  confirm_each_run INTEGER NOT NULL CHECK(confirm_each_run IN (0,1)),
  terms_confirmed INTEGER NOT NULL CHECK(terms_confirmed IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(provider <> 'claude_code' OR enabled = 0 OR terms_confirmed = 1),
  CHECK(provider = 'claude_code' OR terms_confirmed = 0)
) STRICT;

CREATE TABLE external_sources (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id),
  kind TEXT NOT NULL CHECK(kind IN ('attachment','workspace','owner_text','derived','citation')),
  descriptor TEXT NOT NULL CHECK(json_valid(descriptor)),
  UNIQUE(session_id,kind,descriptor)
) STRICT;

CREATE TABLE external_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  parent_run_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude_code','codex_cli')),
  settings_revision INTEGER NOT NULL CHECK(settings_revision > 0),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  manifest TEXT NOT NULL CHECK(json_valid(manifest)),
  content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 41943040),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX external_snapshots_parent ON external_snapshots(session_id,parent_run_id);

CREATE TABLE external_confirmations (
  delegation_id TEXT PRIMARY KEY REFERENCES delegations(id),
  snapshot_id TEXT NOT NULL REFERENCES external_snapshots(id),
  expires_at INTEGER NOT NULL,
  challenge TEXT NOT NULL UNIQUE CHECK(length(challenge) = 36),
  decision TEXT CHECK(decision IN ('confirmed','owner_selection')),
  decided_at INTEGER,
  CHECK((decision IS NULL) = (decided_at IS NULL))
) STRICT;
