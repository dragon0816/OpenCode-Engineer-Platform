import type { DatabaseSync } from 'node:sqlite';
import type { Destination } from '../channels/transport.ts';
import type { FileIdentity } from '../../../../packages/contracts/src/run.ts';
import type { DelegationInput } from '../opencode/delegation-tools.ts';
import type { WorkItems } from './work-items.ts';

export type Classification = 'public' | 'unclassified' | 'confidential';
export type DelegationParent = { store: 'web' | 'channel'; sessionId: string; runId: string; channel?: Destination };
export type DelegationFile = { fileId: string; name: string; bytes: number; sha256: string; mime: string };
export type FileManifest = DelegationFile & { sourceId: string; classification: Classification; identity: FileIdentity;
  projection?: FileIdentity };
type Terminal = 'succeeded' | 'needs_input' | 'failed' | 'timed_out' | 'cancelled' | 'indeterminate';
export type DelegationResult = { delegationId: string; status: Terminal; summary?: string; files?: DelegationFile[];
  reviewRef?: { reviewId: string }; reasonCode?: string };
type Metrics = { requests?: number; tools?: number; elapsedMs?: number };
type EventRow = { sequence: number; at: number; state: string; reasonCode: string | null; metrics: string | null };
type Row = { id: string; workId: string; parentStore: 'web' | 'channel'; parentSessionId: string; parentRunId: string;
  targetAgentId: string; childSessionId: string | null; childRunId: string | null; requestHash: string;
  status: 'queued' | 'running' | Terminal; reservedRequests: number; reservedTools: number; reservedMs: number;
  usedRequests: number; usedTools: number; elapsedMs: number; createdAt: number; finishedAt: number | null;
  destination: string; result: string | null };
const columns = `d.id, d.work_id AS workId, d.parent_store AS parentStore, d.parent_session_id AS parentSessionId,
  d.parent_run_id AS parentRunId, d.target_agent_id AS targetAgentId, d.child_session_id AS childSessionId, d.child_run_id AS childRunId,
  d.request_hash AS requestHash, d.status, d.reserved_requests AS reservedRequests, d.reserved_tools AS reservedTools,
  d.reserved_ms AS reservedMs, d.used_requests AS usedRequests, d.used_tools AS usedTools, d.elapsed_ms AS elapsedMs,
  d.created_at AS createdAt, d.finished_at AS finishedAt, d.destination, d.result`;

export const budgetFields = {
  delegationsPerMessage: { column: 'delegations_per_message', min: 1, max: 100 },
  executionMsPerDelegation: { column: 'execution_ms_per_delegation', min: 1, max: 600_000 },
  modelRequestsPerDelegation: { column: 'model_requests_per_delegation', min: 1, max: 100 },
  toolCallsPerDelegation: { column: 'tool_calls_per_delegation', min: 1, max: 100 },
  modelRequestsPerMessage: { column: 'model_requests_per_message', min: 1, max: 10_000 },
  toolCallsPerMessage: { column: 'tool_calls_per_message', min: 1, max: 10_000 },
  queueMs: { column: 'queue_ms', min: 1, max: 3_600_000 },
} as const;
const budgetEntries = Object.entries(budgetFields);
export type DelegationBudgets = Record<keyof typeof budgetFields, number>;

export function parseDelegationBudgets(input: Record<string, unknown>) {
  if (Object.keys(input).length !== budgetEntries.length || budgetEntries.some(([key, { min, max }]) => {
    const value = input[key];
    return typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max;
  })) return;
  const budget = input as DelegationBudgets;
  if (budget.modelRequestsPerMessage < budget.modelRequestsPerDelegation || budget.toolCallsPerMessage < budget.toolCallsPerDelegation) return;
  return budget;
}

export class DelegationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class DelegationLedger {
  private readonly db: DatabaseSync;
  private readonly work: WorkItems;

  constructor(db: DatabaseSync, work: WorkItems) {
    this.db = db;
    this.work = work;
  }

  atomic<T>(callback: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  budgets() {
    return this.db.prepare(`SELECT ${budgetEntries.map(([key, { column }]) => `${column} AS ${key}`).join(',')}
      FROM delegation_budget_settings WHERE id=1`).get() as DelegationBudgets;
  }

  saveBudgets(input: DelegationBudgets) {
    this.db.prepare(`UPDATE delegation_budget_settings SET ${budgetEntries.map(([, { column }]) => column + '=?').join(',')}
      WHERE id=1`).run(...budgetEntries.map(([key]) => input[key as keyof DelegationBudgets]));
  }

  specialists() {
    return this.db.prepare(`SELECT a.id,a.name,a.introduction,CASE
      WHEN a.state<>'active' THEN 'paused'
      WHEN EXISTS(SELECT 1 FROM agent_work_items w WHERE w.agent_id=a.id AND w.lease_id IS NOT NULL) THEN 'busy'
      WHEN EXISTS(SELECT 1 FROM agent_work_items w WHERE w.agent_id=a.id AND w.state='queued') THEN 'queued'
      ELSE 'available' END AS status
      FROM agents a WHERE a.role='specialist' ORDER BY a.created_at,a.id`).all();
  }

  checkTarget(id: string) {
    if (!this.db.prepare("SELECT 1 FROM agents WHERE id=? AND role='specialist' AND state='active'").get(id)) {
      throw new DelegationError('DELEGATION_TARGET_UNAVAILABLE');
    }
  }

  activeOrchestrator() {
    return Boolean(this.db.prepare("SELECT 1 FROM agents WHERE id='main' AND role='orchestrator' AND state='active'").get());
  }

  attachmentClassification(workspace: string, id: string, hash: string) {
    return this.db.prepare(`SELECT CASE
      WHEN w.classification='confidential' OR f.classification='confidential' THEN 'confidential'
      WHEN w.classification='public' AND f.classification='public' THEN 'public'
      ELSE 'unclassified' END AS classification
      FROM agent_workspaces w LEFT JOIN file_classifications f
        ON f.workspace_id=w.id AND f.file_kind='attachment' AND f.file_id=? AND f.sha256=? WHERE w.id=?`)
      .get(id, hash, workspace)?.classification as Classification | undefined ?? 'unclassified';
  }

  get(id: string) {
    return this.db.prepare(`SELECT ${columns} FROM delegations d WHERE d.id=?`).get(id) as Row | undefined;
  }

  hasFiles(id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM delegation_files WHERE delegation_id=? LIMIT 1').get(id));
  }

  receipt(row: Row) {
    return row.result ? JSON.parse(row.result) as DelegationResult :
      { delegationId: row.id, status: row.status as 'queued' | 'running', noticeCode: 'DELEGATION_ACCEPTED' };
  }

  inspect(id: string) {
    const row = this.get(id);
    if (!row) return;
    const events = (this.db.prepare(`SELECT sequence,at,state,reason_code AS reasonCode,metrics FROM delegation_events
      WHERE delegation_id=? ORDER BY sequence`).all(id) as EventRow[]).map(({ metrics, ...event }) =>
      ({ ...event, ...(typeof metrics === 'string' && { metrics: JSON.parse(metrics) as Metrics }) }));
    return { receipt: this.receipt(row), events, childSessionId: row.childSessionId, childRunId: row.childRunId };
  }

  event(id: string, state: string, reason?: string, metrics?: Metrics) {
    this.db.prepare(`INSERT INTO delegation_events(delegation_id,sequence,at,state,reason_code,metrics)
      SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,?,? FROM delegation_events WHERE delegation_id=?`)
      .run(id, Date.now(), state, reason ?? null, metrics ? JSON.stringify(metrics) : null, id);
  }

  replay(parent: DelegationParent, key: string, hash: string) {
    const existing = this.db.prepare(`SELECT ${columns} FROM delegation_request_keys k JOIN delegations d ON d.id=k.delegation_id
      WHERE k.parent_store=? AND k.parent_run_id=? AND k.request_key=?`).get(parent.store, parent.runId, key) as Row | undefined;
    if (existing) {
      if (existing.requestHash !== hash) throw new DelegationError('DELEGATION_KEY_CONFLICT');
      this.event(existing.id, 'deduplicated', 'same-key');
      return this.receipt(existing);
    }
    const identical = this.db.prepare(`SELECT ${columns} FROM delegations d
      WHERE d.parent_store=? AND d.parent_run_id=? AND d.request_hash=?`).get(parent.store, parent.runId, hash) as Row | undefined;
    if (identical) {
      this.addKey(parent, key, identical.id);
      this.event(identical.id, 'deduplicated', 'same-content');
      return this.receipt(identical);
    }
  }

  private addKey(parent: DelegationParent, key: string, id: string) {
    this.db.prepare('INSERT INTO delegation_request_keys VALUES (?,?,?,?)').run(parent.store, parent.runId, key, id);
  }

  checkBudget(parent: DelegationParent) {
    const budget = this.budgets();
    const totals = this.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN status IN ('queued','running','indeterminate') THEN reserved_requests ELSE used_requests END),0) AS requests,
      COALESCE(SUM(CASE WHEN status IN ('queued','running','indeterminate') THEN reserved_tools ELSE used_tools END),0) AS tools,
      COALESCE(SUM(CASE WHEN status IN ('queued','running','indeterminate') THEN reserved_ms ELSE elapsed_ms END),0) AS ms
      FROM delegations WHERE parent_store=? AND parent_run_id=?`).get(parent.store, parent.runId)!;
    if (Number(totals.count) >= budget.delegationsPerMessage ||
        Number(totals.requests) + budget.modelRequestsPerDelegation > budget.modelRequestsPerMessage ||
        Number(totals.tools) + budget.toolCallsPerDelegation > budget.toolCallsPerMessage ||
        Number(totals.ms) + budget.executionMsPerDelegation > budget.delegationsPerMessage * budget.executionMsPerDelegation) {
      throw new DelegationError('DELEGATION_BUDGET_EXCEEDED');
    }
    return budget;
  }

  admit(id: string, childRunId: string, parent: DelegationParent, input: DelegationInput, hash: string, files: FileManifest[]) {
    this.checkTarget(input.specialistId);
    const budget = this.checkBudget(parent);
    const now = Date.now();
    const { item } = this.work.enqueue({ agentId: input.specialistId, source: 'delegation', sourceKey: id, effectClass: 'write',
      run: { store: 'web', id: childRunId }, expiresAt: now + budget.queueMs, payload: { kind: 'delegation', task: input.task } }, now);
    this.db.prepare(`INSERT INTO delegations(id,work_id,parent_store,parent_session_id,parent_run_id,target_agent_id,request_key,
      request_hash,status,reserved_requests,reserved_tools,reserved_ms,created_at,destination)
      VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)`).run(id, item.id, parent.store, parent.sessionId, parent.runId, input.specialistId,
      input.requestKey, hash, budget.modelRequestsPerDelegation, budget.toolCallsPerDelegation, budget.executionMsPerDelegation, now,
      JSON.stringify(parent.channel ?? { sessionId: parent.sessionId }));
    this.addKey(parent, input.requestKey, id);
    this.addFiles(id, 'inbound', files);
    this.event(id, 'queued', 'accepted');
    return this.receipt(this.get(id)!);
  }

  private addFiles(id: string, direction: 'inbound' | 'outbound', files: FileManifest[]) {
    const insert = this.db.prepare('INSERT INTO delegation_files VALUES (?,?,?,?,?,?,?,?,?)');
    for (const file of files) insert.run(id, file.fileId, direction, file.sourceId, file.name, file.bytes, file.sha256, file.classification,
      JSON.stringify({ sourceId: file.sourceId, sha256: file.sha256, mime: file.mime, identity: file.identity, projection: file.projection }));
  }

  files(id: string, direction: 'inbound' | 'outbound') {
    return this.db.prepare(`SELECT file_id AS fileId,source_file_id AS sourceId,name,bytes,sha256,classification,provenance
      FROM delegation_files WHERE delegation_id=? AND direction=? ORDER BY rowid`).all(id, direction)
      .map(({ provenance, ...file }) => ({ ...JSON.parse(String(provenance)), ...file } as FileManifest));
  }
}
