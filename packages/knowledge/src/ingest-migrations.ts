export const ingestMigration = `
CREATE TABLE IF NOT EXISTS inactive_vaults (
  vault TEXT PRIMARY KEY REFERENCES vaults(id)
) STRICT;
CREATE TABLE IF NOT EXISTS review_uploads (
  hash TEXT PRIMARY KEY REFERENCES blobs(hash)
) STRICT;
CREATE TABLE IF NOT EXISTS review_schemas (
  vault TEXT NOT NULL, version TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(vault, version)
) STRICT;
CREATE TABLE IF NOT EXISTS review_schema_heads (
  vault TEXT PRIMARY KEY, version TEXT NOT NULL,
  FOREIGN KEY(vault, version) REFERENCES review_schemas(vault, version)
) STRICT;
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, vault TEXT NOT NULL, parent TEXT, original TEXT NOT NULL, draft TEXT NOT NULL,
  edit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', publication TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS review_edits (
  review TEXT NOT NULL REFERENCES reviews(id), edit INTEGER NOT NULL, draft TEXT NOT NULL, PRIMARY KEY(review, edit)
) STRICT;
CREATE TABLE IF NOT EXISTS notification_intents (
  review TEXT PRIMARY KEY REFERENCES reviews(id), vault TEXT NOT NULL, revision TEXT NOT NULL
) STRICT;
`;

export const jobsMigration = `
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, lease TEXT, expires INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS ingest_effects (
  job TEXT PRIMARY KEY REFERENCES ingest_jobs(id), review TEXT NOT NULL REFERENCES reviews(id)
) STRICT;
`;
