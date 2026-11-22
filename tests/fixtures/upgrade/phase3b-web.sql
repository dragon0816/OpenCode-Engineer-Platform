-- SQLite DDL captured from 6c511e6 (schema-equivalent to db4ff99).
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE run_events (
  sequence INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at INTEGER NOT NULL,
  state TEXT NOT NULL,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY,
  upstream_id TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL CHECK(agent IN ('inspector', 'workbook')),
  alias TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  record TEXT NOT NULL
) STRICT;
CREATE INDEX attachments_by_session ON attachments(session_id);
CREATE TABLE web_turns (
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  request_hash TEXT NOT NULL
) STRICT;
CREATE INDEX web_turns_by_session ON web_turns(session_id);
CREATE TABLE web_session_display (
      id TEXT PRIMARY KEY REFERENCES web_sessions(id),
      title TEXT,
      removed INTEGER NOT NULL DEFAULT 0
    ) STRICT;
CREATE TABLE web_session_project (
      id TEXT PRIMARY KEY REFERENCES web_sessions(id),
      project TEXT NOT NULL
    ) STRICT;
CREATE TABLE web_preferences (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      name TEXT NOT NULL,
      introduction TEXT NOT NULL,
      instructions TEXT NOT NULL
    ) STRICT;
CREATE TABLE web_settings_audit (
      id INTEGER PRIMARY KEY,
      section TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE web_turn_limits (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      settings TEXT NOT NULL
    ) STRICT;
CREATE TABLE web_model_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      alias TEXT NOT NULL
    ) STRICT;
CREATE TABLE web_model_catalog (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      ids TEXT NOT NULL,
      discovered_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE web_model_selection (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      ids TEXT NOT NULL
    ) STRICT;
CREATE TABLE web_project_folders (
      project TEXT NOT NULL,
      folder TEXT NOT NULL,
      PRIMARY KEY(project, folder)
    ) STRICT;
CREATE TABLE web_action_decisions (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES web_sessions(id),
      action TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE web_message_annotations (
      session_id TEXT NOT NULL REFERENCES web_sessions(id),
      message_id TEXT NOT NULL,
      note TEXT,
      rating TEXT,
      reason TEXT,
      PRIMARY KEY(session_id, message_id)
    ) STRICT;
CREATE TABLE web_turn_replies (
      run_id TEXT PRIMARY KEY REFERENCES runs(id),
      message_id TEXT NOT NULL,
      text TEXT NOT NULL
    ) STRICT;
CREATE TABLE web_session_knowledge_disabled (
      id TEXT PRIMARY KEY REFERENCES web_sessions(id)
    ) STRICT;
CREATE TABLE web_knowledge_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      atlas_url TEXT NOT NULL,
      toolbox INTEGER NOT NULL CHECK(toolbox IN (0, 1))
    ) STRICT;
CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY NOT NULL,
      definition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE web_appearance (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      theme TEXT NOT NULL,
      density TEXT NOT NULL,
      avatar BLOB,
      mime TEXT
    ) STRICT;
PRAGMA user_version = 2;
