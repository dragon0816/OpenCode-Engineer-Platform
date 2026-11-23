import type { DatabaseSync } from 'node:sqlite';
import type { Destination } from '../channels/transport.ts';
import type { FileIdentity } from '../../../../packages/contracts/src/run.ts';
import type { DelegationInput } from '../opencode/delegation-tools.ts';
import type { WorkItems } from './work-items.ts';
import type { WorkItem, WorkLease, WorkOutcome } from './work-items.ts';

export type Classification = 'public' | 'unclassified' | 'confidential';
export type DelegationParent = { store: 'web' | 'channel'; sessionId: string; runId: string; channel?: Destination };
export type DelegationFile = { fileId: string; name: string; bytes: number; sha256: string; mime: string };
export type FileManifest = DelegationFile & { sourceId: string; classification: Classification; identity: FileIdentity;
  projection?: FileIdentity };
type Terminal = 'succeeded' | 'needs_input' | 'failed' | 'timed_out' | 'cancelled' | 'indeterminate';
export type DelegationResult = { delegationId: string; status: Terminal; summary?: string; files?: DelegationFile[];
  reviewRef?: { reviewId: string }; changes?: { count: number; manifestSha256: string }; reasonCode?: string };
type Metrics = { requests?: number; tools?: number; elapsedMs?: number; version?: string; settingsRevision?: number;
  sourceCount?: number; members?: number; orphans?: number };
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

  specialists(includeExternal = false) {
    return this.db.prepare(`SELECT a.id,a.name,a.introduction,CASE
      WHEN a.state<>'active' THEN 'paused'
      WHEN EXISTS(SELECT 1 FROM agent_work_items w WHERE w.agent_id=a.id AND w.lease_id IS NOT NULL) THEN 'busy'
      WHEN EXISTS(SELECT 1 FROM agent_work_items w WHERE w.agent_id=a.id AND w.state='queued') THEN 'queued'
      ELSE 'available' END AS status
      FROM agents a WHERE a.role='specialist' AND (? OR a.id NOT IN ('external-codex-cli','external-claude-code'))
      ORDER BY a.created_at,a.id`).all(Number(includeExternal));
  }

  checkTarget(id: string, external = false) {
    if (!this.db.prepare("SELECT 1 FROM agents WHERE id=? AND role='specialist' AND state='active' AND (? OR id NOT IN ('external-codex-cli','external-claude-code'))")
      .get(id, Number(external))) {
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
    return { receipt: { delegationId: row.id, status: row.status, noticeCode: 'DELEGATION_ACCEPTED' },
      result: row.result && JSON.parse(row.result) as DelegationResult, events,
      childSessionId: row.childSessionId, childRunId: row.childRunId };
  }

  cards(sessionId: string) {
    const rows = this.db.prepare(`SELECT ${columns},a.name AS specialistName,
      EXISTS (SELECT 1 FROM delegation_notices n WHERE n.delegation_id=d.id AND n.seen_at IS NULL
        AND n.kind IN ('completion','correction')) AS unread,
      EXISTS (SELECT 1 FROM delegation_events e WHERE e.delegation_id=d.id
        AND e.reason_code IN ('completed-during-cancellation','outcome-already-recorded')
        AND d.status IN ('succeeded','needs_input')) AS completedDuringCancellation
      FROM delegations d JOIN agents a ON a.id=d.target_agent_id
      WHERE d.parent_store='web' AND d.parent_session_id=? ORDER BY d.created_at,d.rowid`)
      .all(sessionId) as (Row & { specialistName: string; unread: number; completedDuringCancellation: number })[];
    return rows.map((row) => ({ ...this.receipt(row), parentRunId: row.parentRunId, targetAgentId: row.targetAgentId,
      specialistName: row.specialistName, unread: Boolean(row.unread),
      completedDuringCancellation: Boolean(row.completedDuringCancellation) }));
  }

  markSeen(sessionId: string, id: string) {
    return Boolean(this.db.prepare(`UPDATE delegation_notices SET seen_at=?
      WHERE delegation_id=? AND kind IN ('completion','correction') AND seen_at IS NULL AND EXISTS (
        SELECT 1 FROM delegations WHERE id=? AND parent_store='web' AND parent_session_id=?)`)
      .run(Date.now(), id, id, sessionId).changes);
  }

  channelNotices() {
    return this.db.prepare(`SELECT ${columns},a.name AS specialistName,n.kind,n.effect_key AS effectKey,
      EXISTS(SELECT 1 FROM delegation_notices c WHERE c.delegation_id=d.id AND c.kind='correction') AS corrected
      FROM delegation_notices n JOIN delegations d ON n.delegation_id=d.id JOIN agents a ON a.id=d.target_agent_id
      WHERE d.parent_store='channel' AND n.state='pending' ORDER BY n.rowid`).all() as
      (Row & { specialistName: string; kind: 'acceptance' | 'completion' | 'correction'; effectKey: string; corrected: number })[];
  }

  markOutboxed(effectKey: string) {
    this.db.prepare("UPDATE delegation_notices SET state='outboxed' WHERE effect_key=? AND state='pending'").run(effectKey);
  }

  publicationParent(reviewId: string) {
    if (!reviewId.startsWith('delegation-')) return;
    const row = this.db.prepare(`SELECT ${columns} FROM delegations d WHERE child_run_id=? AND target_agent_id='bi'
      AND status='succeeded' AND json_extract(result,'$.reviewRef.reviewId')=?`)
      .get(reviewId.slice('delegation-'.length), reviewId) as Row | undefined;
    if (!row) return;
    const completionOutboxed = Boolean(this.db.prepare(`SELECT 1 FROM delegation_notices
      WHERE delegation_id=? AND kind IN ('completion','correction') AND state='outboxed'
      AND NOT EXISTS(SELECT 1 FROM delegation_notices WHERE delegation_id=? AND state='pending')`).get(row.id, row.id));
    return { ...row, completionOutboxed };
  }

  context(parent: DelegationParent, before: number) {
    const rows = this.db.prepare(`SELECT d.id,d.status,d.result,a.name FROM delegations d
      JOIN agents a ON a.id=d.target_agent_id
      WHERE d.parent_store=? AND d.parent_session_id=? AND d.parent_run_id<>? AND d.finished_at<=?
      ORDER BY d.finished_at DESC,d.rowid DESC LIMIT 6`).all(parent.store, parent.sessionId, parent.runId, before);
    return rows.map(({ id, status, result, name }) => {
      const { summary, files, reviewRef } = JSON.parse(String(result)) as DelegationResult;
      return { delegationId: id, specialist: name, status, summary: summary?.slice(0, 500).toWellFormed(),
        fileIds: files?.map((file) => file.fileId), reviewId: reviewRef?.reviewId };
    });
  }

  claim(item: WorkLease) {
    this.atomic(() => {
      const { sourceKey: id } = item;
      if (!this.db.prepare("UPDATE delegations SET status='running' WHERE id=? AND work_id=? AND status='queued'")
        .run(id, item.id).changes) throw new DelegationError('DELEGATION_LEASE_UNAVAILABLE');
      this.event(id, 'running', 'claimed');
    });
  }

  bindChild(id: string, sessionId: string, runId?: string) {
    if (!this.db.prepare(`UPDATE delegations SET child_session_id=?,child_run_id=? WHERE id=? AND status='running'
      AND (child_session_id IS NULL OR child_session_id=?) AND child_run_id IS NULL
      AND EXISTS (SELECT 1 FROM session_ownership o WHERE o.session_id=? AND o.origin='delegation' AND o.agent_id=target_agent_id)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM agent_work_items w WHERE w.id=work_id AND w.run_id=? AND w.run_store='web'))`)
      .run(sessionId, runId ?? null, id, sessionId, sessionId, runId ?? null, runId ?? null).changes) {
      throw new DelegationError('DELEGATION_CHILD_UNAVAILABLE');
    }
  }

  prepareExports(id: string, files: FileManifest[]) {
    this.atomic(() => this.addFiles(id, 'outbound', files));
  }

  classifyImport(workspaceId: string, id: string, hash: string, classification: Classification) {
    this.db.prepare(`INSERT INTO file_classifications VALUES ('attachment',?,?,?,?,?)`)
      .run(id, workspaceId, hash, classification, Date.now());
  }

  workspaceClassification(workspaceId: string) {
    return this.db.prepare('SELECT classification FROM agent_workspaces WHERE id=?').get(workspaceId)?.classification as Classification;
  }

  meter(id: string, kind: 'requests' | 'tools', cap: number) {
    return this.atomic(() => {
      const used = kind === 'requests' ? 'used_requests' : 'used_tools';
      const reserved = kind === 'requests' ? 'reserved_requests' : 'reserved_tools';
      const result = this.db.prepare(`UPDATE delegations SET ${used}=${used}+1
        WHERE id=? AND status='running' AND ${used}<MIN(${reserved},?) RETURNING ${used} AS count`).get(id, cap);
      if (!result) return false;
      this.event(id, 'running', kind, { [kind]: Number(result.count) });
      return true;
    });
  }

  chargeExternal(id: string) {
    const row = this.db.prepare(`UPDATE delegations SET used_requests=reserved_requests,used_tools=reserved_tools
      WHERE id=? AND status='running' AND used_requests=0 AND used_tools=0 AND reserved_requests>0 AND reserved_tools>0
      RETURNING used_requests AS requests,used_tools AS tools`).get(id);
    if (!row) throw new DelegationError('external-budget-unavailable');
    this.event(id, 'running', 'external-budget-charged', { requests: Number(row.requests), tools: Number(row.tools) });
  }

  elapsed(id: string) {
    const start = this.db.prepare("SELECT at FROM delegation_events WHERE delegation_id=? AND state='running' AND reason_code='claimed'")
      .get(id)?.at;
    return typeof start === 'number' ? Math.max(0, Date.now() - start) : 0;
  }

  finish(item: WorkLease, state: WorkOutcome, reason?: string, landed?: Omit<DelegationResult, 'delegationId'>) {
    return this.atomic(() => {
      if (!this.work.finish(item, state, reason)) return false;
      if (landed && this.db.prepare("SELECT 1 FROM delegation_events WHERE delegation_id=? AND reason_code='cancellation-requested'")
        .get(item.sourceKey)) this.event(item.sourceKey, 'running', 'completed-during-cancellation');
      this.settle(item.sourceKey, landed ?? { status: state, reasonCode: reason });
      return true;
    });
  }

  resolve(item: WorkLease, state: 'succeeded' | 'failed' | 'cancelled', landed?: Omit<DelegationResult, 'delegationId'>) {
    return this.atomic(() => {
      if (!this.work.resolve(item.id, item.leaseId, state)) return false;
      this.settle(item.sourceKey, landed ?? { status: state, reasonCode: 'owner-resolved' }, true);
      return true;
    });
  }

  expire(item: WorkItem) {
    this.settle(item.sourceKey, { status: 'timed_out', reasonCode: 'queue-expired' });
  }

  cancel(id: string) {
    return this.atomic(() => {
      const row = this.get(id);
      if (!row) return;
      if (row.status === 'queued' && this.work.cancel(row.workId)) {
        this.settle(id, { status: 'cancelled', reasonCode: 'cancelled-before-dispatch' });
      } else {
        const reason = row.status === 'running' || row.status === 'queued' ? 'cancellation-requested' : 'outcome-already-recorded';
        this.event(id, row.status, reason);
      }
      return this.get(id);
    });
  }

  private settle(id: string, result: Omit<DelegationResult, 'delegationId'>, resolving = false) {
    const row = this.get(id);
    if (!row || !(resolving ? row.status === 'indeterminate' : row.status === 'queued' || row.status === 'running')) {
      throw new DelegationError('DELEGATION_LEASE_UNAVAILABLE');
    }
    const elapsedMs = resolving ? row.elapsedMs : Math.min(row.reservedMs, this.elapsed(id));
    const { status, reasonCode } = result;
    const response = { ...result, delegationId: id };
    this.db.prepare('UPDATE delegations SET status=?,elapsed_ms=?,finished_at=?,result=? WHERE id=?')
      .run(status, elapsedMs, Date.now(), JSON.stringify(response), id);
    this.event(id, status, reasonCode, { requests: row.usedRequests, tools: row.usedTools, elapsedMs });
    const kind = resolving ? 'correction' : 'completion';
    this.db.prepare("INSERT INTO delegation_notices (delegation_id,kind,state,effect_key,created_at) VALUES (?,?,'pending',?,?)")
      .run(id, kind, `delegation:${id}:${kind}`, Date.now());
    this.event(id, status, 'notice-pending');
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
      COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN reserved_requests ELSE used_requests END),0) AS requests,
      COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN reserved_tools ELSE used_tools END),0) AS tools,
      COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN reserved_ms ELSE elapsed_ms END),0) AS ms
      FROM delegations WHERE parent_store=? AND parent_run_id=?`).get(parent.store, parent.runId)!;
    if (Number(totals.count) >= budget.delegationsPerMessage ||
        Number(totals.requests) + budget.modelRequestsPerDelegation > budget.modelRequestsPerMessage ||
        Number(totals.tools) + budget.toolCallsPerDelegation > budget.toolCallsPerMessage ||
        Number(totals.ms) + budget.executionMsPerDelegation > budget.delegationsPerMessage * budget.executionMsPerDelegation) {
      throw new DelegationError('DELEGATION_BUDGET_EXCEEDED');
    }
    return budget;
  }

  admit(id: string, childRunId: string, parent: DelegationParent, input: DelegationInput, hash: string, files: FileManifest[],
    external?: { wait: boolean }) {
    this.checkTarget(input.specialistId, Boolean(external));
    const budget = this.checkBudget(parent);
    const now = Date.now();
    const expiresAt = now + budget.queueMs;
    const { item } = this.work.enqueue({ agentId: input.specialistId, source: 'delegation', sourceKey: id, effectClass: 'write',
      run: { store: 'web', id: childRunId }, expiresAt, readyAt: external?.wait ? expiresAt : now,
      payload: external ? { kind: 'external-delegation' } : { kind: 'delegation', task: input.task } }, now);
    this.db.prepare(`INSERT INTO delegations(id,work_id,parent_store,parent_session_id,parent_run_id,target_agent_id,request_key,
      request_hash,status,reserved_requests,reserved_tools,reserved_ms,created_at,destination)
      VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)`).run(id, item.id, parent.store, parent.sessionId, parent.runId, input.specialistId,
      input.requestKey, hash, budget.modelRequestsPerDelegation, budget.toolCallsPerDelegation, budget.executionMsPerDelegation, now,
      JSON.stringify(parent.channel ?? { sessionId: parent.sessionId }));
    this.addKey(parent, input.requestKey, id);
    this.addFiles(id, 'inbound', files);
    this.event(id, 'queued', 'accepted');
    if (parent.channel) this.db.prepare(`INSERT INTO delegation_notices (delegation_id,kind,state,effect_key,created_at)
      VALUES (?,'acceptance','pending',?,?)`).run(id, `delegation:${id}:acceptance`, now);
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
