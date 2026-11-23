CREATE TABLE local_references (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  revision TEXT NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record)),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
) STRICT;

CREATE INDEX local_references_by_session ON local_references(session_id, revoked);

CREATE TABLE local_reference_members (
  reference_id TEXT NOT NULL REFERENCES local_references(id),
  member TEXT NOT NULL,
  identity TEXT NOT NULL CHECK(json_valid(identity)),
  PRIMARY KEY(reference_id, member)
) STRICT;

CREATE TABLE local_reference_audit (
  sequence INTEGER PRIMARY KEY,
  reference_id TEXT NOT NULL REFERENCES local_references(id),
  event TEXT NOT NULL CHECK(event IN ('attach', 'reconfirm', 'revoke', 'classify', 'read', 'list', 'open')),
  identity_hash TEXT NOT NULL CHECK(length(identity_hash) = 64),
  chunk_hash TEXT CHECK(length(chunk_hash) = 64),
  at INTEGER NOT NULL
) STRICT;
