CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL UNIQUE REFERENCES agent_work_items(id),
  parent_store TEXT NOT NULL CHECK(parent_store IN ('web', 'channel')),
  parent_session_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL REFERENCES agents(id) CHECK(target_agent_id <> 'main'),
  child_session_id TEXT REFERENCES web_sessions(id),
  child_run_id TEXT UNIQUE REFERENCES runs(id),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 64),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'needs_input', 'failed', 'timed_out', 'cancelled', 'indeterminate')),
  reserved_requests INTEGER NOT NULL CHECK(reserved_requests >= 0),
  reserved_tools INTEGER NOT NULL CHECK(reserved_tools >= 0),
  reserved_ms INTEGER NOT NULL CHECK(reserved_ms >= 0),
  used_requests INTEGER NOT NULL DEFAULT 0 CHECK(used_requests >= 0),
  used_tools INTEGER NOT NULL DEFAULT 0 CHECK(used_tools >= 0),
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_ms >= 0),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  destination TEXT NOT NULL CHECK(json_valid(destination)),
  UNIQUE(parent_store, parent_run_id, request_key),
  UNIQUE(parent_store, parent_run_id, request_hash),
  UNIQUE(parent_store, parent_run_id, id),
  CHECK(child_run_id IS NULL OR child_session_id IS NOT NULL),
  CHECK((status IN ('queued', 'running') AND finished_at IS NULL AND result IS NULL) OR
    (status NOT IN ('queued', 'running') AND finished_at IS NOT NULL AND result IS NOT NULL))
) STRICT;

CREATE INDEX delegations_parent_session ON delegations(parent_store, parent_session_id, created_at);

CREATE TABLE delegation_events (
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  at INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason_code TEXT,
  metrics TEXT CHECK(metrics IS NULL OR json_valid(metrics)),
  PRIMARY KEY(delegation_id, sequence)
) STRICT;

CREATE TABLE delegation_request_keys (
  parent_store TEXT NOT NULL CHECK(parent_store IN ('web', 'channel')),
  parent_run_id TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 64),
  delegation_id TEXT NOT NULL,
  PRIMARY KEY(parent_store, parent_run_id, request_key),
  FOREIGN KEY(parent_store, parent_run_id, delegation_id) REFERENCES delegations(parent_store, parent_run_id, id)
) STRICT;

CREATE TABLE delegation_files (
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  file_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  source_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 41943040),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  classification TEXT NOT NULL CHECK(classification IN ('unclassified', 'public', 'confidential')),
  provenance TEXT NOT NULL CHECK(json_valid(provenance)),
  PRIMARY KEY(delegation_id, file_id)
) STRICT;

CREATE TABLE delegation_notices (
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  effect_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  seen_at INTEGER,
  PRIMARY KEY(delegation_id, kind)
) STRICT;
