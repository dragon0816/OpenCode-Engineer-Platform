CREATE TABLE agent_work_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('direct', 'delegation', 'schedule')),
  source_key TEXT NOT NULL,
  effect_class TEXT NOT NULL CHECK(effect_class IN ('write', 'verified_read')),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate', 'timed_out')),
  enqueued_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  expires_at INTEGER,
  lease_id TEXT,
  lease_until INTEGER,
  run_store TEXT CHECK(run_store IN ('web', 'channel')),
  run_id TEXT,
  schedule_ref TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  reason_code TEXT,
  UNIQUE(source, source_key),
  CHECK((state IN ('running', 'indeterminate')) = (lease_id IS NOT NULL)),
  CHECK((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK((run_store IS NULL) = (run_id IS NULL))
) STRICT;

CREATE INDEX agent_work_items_pending ON agent_work_items(agent_id, state, ready_at, enqueued_at, id);

CREATE UNIQUE INDEX agent_work_items_write_lease ON agent_work_items(agent_id)
  WHERE effect_class = 'write' AND lease_id IS NOT NULL;
