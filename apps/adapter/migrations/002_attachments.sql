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
  request_hash TEXT NOT NULL,
  workbook INTEGER NOT NULL CHECK(workbook IN (0, 1))
) STRICT;

CREATE INDEX web_turns_by_session ON web_turns(session_id);
