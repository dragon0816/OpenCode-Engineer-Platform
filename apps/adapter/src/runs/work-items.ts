import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';

const definitions = () => readFileSync(atRepo('apps/adapter/migrations/004_agent_work_items.sql'), 'utf8');

export function migrateWorkItems(db: DatabaseSync) {
  db.exec(definitions());
}

export function verifyWorkItems(db: DatabaseSync) {
  const saved = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='agent_work_items' AND sql IS NOT NULL").all();
  const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');
  const actual = new Set(saved.map(({ sql }) => normalize(String(sql))));
  const expected = definitions().split(';').map(normalize).filter(Boolean);
  if (actual.size !== expected.length || expected.some((sql) => !actual.has(sql))) {
    throw new Error('agent_work_items schema or lease indexes do not match the migration');
  }
}

type Source = 'direct' | 'delegation' | 'schedule';
type EffectClass = 'write' | 'verified_read';
type RunStore = 'web' | 'channel';
export type WorkOutcome = 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' | 'timed_out';
export type ResolvedOutcome = Exclude<WorkOutcome, 'indeterminate' | 'timed_out'>;
type State = 'queued' | 'running' | WorkOutcome;
export type WorkPayload = { kind: string; serialKey?: string } & Record<string, unknown>;
export type WorkRequest = {
  id?: string; agentId: string; source: Source; sourceKey: string; effectClass: EffectClass;
  payload: WorkPayload; readyAt?: number; expiresAt?: number; run?: { store: RunStore; id: string }; scheduleRef?: string;
};
type WorkRow = {
  id: string; agentId: string; source: Source; sourceKey: string; effectClass: EffectClass; state: State;
  enqueuedAt: number; readyAt: number; expiresAt: number | null; leaseId: string | null; leaseUntil: number | null;
  runStore: RunStore | null; runId: string | null; scheduleRef: string | null; payload: string; reasonCode: string | null;
};
export type WorkItem = Omit<WorkRow, 'payload'> & { payload: WorkPayload };
export type WorkLease = WorkItem & { leaseId: string };
const columns = `id, agent_id AS agentId, source, source_key AS sourceKey, effect_class AS effectClass, state,
  enqueued_at AS enqueuedAt, ready_at AS readyAt, expires_at AS expiresAt, lease_id AS leaseId,
  lease_until AS leaseUntil, run_store AS runStore, run_id AS runId, schedule_ref AS scheduleRef, payload, reason_code AS reasonCode`;
const decode = (row: WorkRow) => ({ ...row, payload: JSON.parse(row.payload) as WorkPayload });

export class WorkItems {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  enqueue(request: WorkRequest, now = Date.now()) {
    const queueBudget = request.source === 'delegation'
      ? Number(this.db.prepare('SELECT queue_ms FROM delegation_budget_settings WHERE id=1').get()?.queue_ms ?? 600_000)
      : undefined;
    const expiresAt = request.expiresAt ?? (queueBudget === undefined ? null : now + queueBudget);
    const { run, payload } = request;
    const body = JSON.stringify(payload);
    const inserted = this.db.prepare(`INSERT INTO agent_work_items
      (id,agent_id,source,source_key,effect_class,state,enqueued_at,ready_at,expires_at,run_store,run_id,schedule_ref,payload)
      VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?) ON CONFLICT(source,source_key) DO NOTHING`).run(
      request.id ?? randomUUID(), request.agentId, request.source, request.sourceKey, request.effectClass, now,
      request.readyAt ?? now, expiresAt, run?.store ?? null, run?.id ?? null, request.scheduleRef ?? null, body);
    const row = this.db.prepare(`SELECT ${columns} FROM agent_work_items WHERE source=? AND source_key=?`)
      .get(request.source, request.sourceKey) as WorkRow;
    if (row.agentId !== request.agentId || row.effectClass !== request.effectClass || row.payload !== body ||
        row.runStore !== (run?.store ?? null) || row.runId !== (run?.id ?? null) || row.scheduleRef !== (request.scheduleRef ?? null)) {
      throw new Error('Work key already exists with different input');
    }
    return { item: decode(row), inserted: Boolean(inserted.changes) };
  }

  get(id: string) {
    const row = this.db.prepare(`SELECT ${columns} FROM agent_work_items WHERE id=?`).get(id) as WorkRow | undefined;
    return row && decode(row);
  }

  find(source: Source, key: string) {
    const row = this.db.prepare(`SELECT ${columns} FROM agent_work_items WHERE source=? AND source_key=?`)
      .get(source, key) as WorkRow | undefined;
    return row && decode(row);
  }

  byRun(store: RunStore, id: string) {
    const row = this.db.prepare(`SELECT ${columns} FROM agent_work_items WHERE run_store=? AND run_id=?`)
      .get(store, id) as WorkRow | undefined;
    return row && decode(row);
  }

  withLease() {
    return (this.db.prepare(`SELECT ${columns} FROM agent_work_items
      WHERE lease_id IS NOT NULL ORDER BY enqueued_at,id`).all() as WorkRow[]).map(decode) as WorkLease[];
  }

  scheduleOccupied(scheduleRef: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM agent_work_items
      WHERE source='schedule' AND schedule_ref=? AND lease_id IS NOT NULL LIMIT 1`).get(scheduleRef));
  }

  expire(now = Date.now(), expired?: (item: WorkItem) => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const items = (this.db.prepare(`UPDATE agent_work_items SET state='timed_out',reason_code='queue-expired'
        WHERE state='queued' AND expires_at<=? RETURNING ${columns}`).all(now) as WorkRow[]).map(decode);
      for (const item of items) expired?.(item);
      this.db.exec('COMMIT');
      return items;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claim(available: (item: WorkItem) => boolean, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT ${columns} FROM agent_work_items AS item
        WHERE state='queued' AND ready_at<=? AND (expires_at IS NULL OR expires_at>?)
        AND NOT EXISTS (SELECT 1 FROM agent_work_items AS held WHERE held.lease_id IS NOT NULL AND (
          (item.effect_class='write' AND held.effect_class='write' AND held.agent_id=item.agent_id)
          OR json_extract(held.payload,'$.serialKey')=json_extract(item.payload,'$.serialKey')))
        ORDER BY CASE source WHEN 'direct' THEN 0 WHEN 'delegation' THEN 1 ELSE 2 END, enqueued_at, id`);
      let candidate: WorkItem | undefined;
      for (const row of rows.iterate(now, now) as Iterable<WorkRow>) {
        const item = decode(row);
        if (available(item)) {
          candidate = item;
          break;
        }
      }
      let claimed: WorkLease | undefined;
      if (candidate) {
        const leaseId = randomUUID();
        const leaseUntil = now + 600_000;
        this.db.prepare("UPDATE agent_work_items SET state='running',lease_id=?,lease_until=? WHERE id=?")
          .run(leaseId, leaseUntil, candidate.id);
        claimed = { ...candidate, state: 'running', leaseId, leaseUntil };
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markStarted({ id, leaseId }: WorkLease) {
    return Boolean(this.db.prepare(`UPDATE agent_work_items SET reason_code='execution-started'
      WHERE id=? AND lease_id=? AND state='running'`).run(id, leaseId).changes);
  }

  finish({ id, leaseId }: Pick<WorkLease, 'id' | 'leaseId'>, outcome: WorkOutcome, reason?: string) {
    const retain = outcome === 'indeterminate';
    return Boolean(this.db.prepare(`UPDATE agent_work_items SET state=?,reason_code=?,
      lease_id=CASE WHEN ? THEN lease_id END,lease_until=CASE WHEN ? THEN lease_until END
      WHERE id=? AND lease_id=? AND state='running'`)
      .run(outcome, reason ?? null, Number(retain), Number(retain), id, leaseId).changes);
  }

  requeue({ id, leaseId }: WorkLease, readyAt?: number) {
    return Boolean(this.db.prepare(`UPDATE agent_work_items SET state='queued',lease_id=NULL,lease_until=NULL,reason_code=NULL,
      ready_at=COALESCE(?,ready_at) WHERE id=? AND lease_id=? AND state='running'`).run(readyAt ?? null, id, leaseId).changes);
  }

  cancel(id: string) {
    return Boolean(this.db.prepare(`UPDATE agent_work_items SET state='cancelled',reason_code='cancelled-before-dispatch'
      WHERE id=? AND state='queued'`).run(id).changes);
  }

  resolve(id: string, leaseId: string, outcome: ResolvedOutcome) {
    return Boolean(this.db.prepare(`UPDATE agent_work_items SET state=?,lease_id=NULL,lease_until=NULL,reason_code='owner-resolved'
      WHERE id=? AND lease_id=? AND state='indeterminate'`).run(outcome, id, leaseId).changes);
  }
}
