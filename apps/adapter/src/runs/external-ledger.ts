import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DelegationError, type Classification } from './delegation-ledger.ts';

export const helpers = {
  codex_cli: { id: 'external-codex-cli', name: 'Codex' },
  claude_code: { id: 'external-claude-code', name: 'Claude Code' },
} as const;
export type Provider = keyof typeof helpers;
export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && Object.hasOwn(helpers, value);
export const externalProvider = (id: unknown) => (Object.keys(helpers) as Provider[]).find((key) => helpers[key].id === id);
export type HelperSettings = { provider: Provider; enabled: boolean; confirmEachRun: boolean; termsConfirmed: boolean; revision: number };
export type SourceDescriptor =
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'workspace'; folder: string; path: string }
  | { kind: 'owner_text'; text: string }
  | { kind: 'derived'; text: string; sources: string[] }
  | { kind: 'citation'; vault: string; revision: string; passage: string; sha256: string };
export type ExternalSource = { id: string; sessionId: string; workspaceId: string; descriptor: SourceDescriptor };
export type SnapshotFile = { sourceId: string; kind: SourceDescriptor['kind']; name: string; sha256: string; bytes: number;
  provenance: unknown; parents: SnapshotFile[]; projection?: { sha256: string; bytes: number } };
export type SnapshotManifest = { task: SnapshotFile; inputs: SnapshotFile[] };
export type Snapshot = { id: string; sessionId: string; parentRunId: string; provider: Provider; settingsRevision: number;
  digest: string; manifest: SnapshotManifest; content: Uint8Array };
type Confirmation = { snapshotId: string; expiresAt: number; challenge: string;
  decision: 'confirmed' | 'owner_selection' | null; decidedAt: number | null };

export class ExternalLedger {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  settings(provider: Provider): HelperSettings {
    const row = this.db.prepare('SELECT * FROM external_helper_settings WHERE provider=?').get(provider);
    return { provider, enabled: row?.enabled === 1, confirmEachRun: row?.confirm_each_run !== 0,
      termsConfirmed: row?.terms_confirmed === 1, revision: Number(row?.revision ?? 1) };
  }

  saveSettings(next: HelperSettings) {
    const current = this.settings(next.provider);
    if (next.revision !== current.revision) throw new DelegationError('external-settings-changed');
    if (next.provider === 'claude_code' && next.enabled && !next.termsConfirmed) throw new DelegationError('external-terms-required');
    if (next.enabled === current.enabled && next.confirmEachRun === current.confirmEachRun &&
        next.termsConfirmed === current.termsConfirmed) return current;
    const revision = current.revision + 1;
    this.db.prepare('INSERT OR REPLACE INTO external_helper_settings VALUES (?,?,?,?,?)')
      .run(next.provider, Number(next.enabled), Number(next.confirmEachRun), Number(next.termsConfirmed), revision);
    return { ...next, revision };
  }

  ensureTarget(provider: Provider) {
    const { id, name } = helpers[provider];
    const now = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO agents VALUES (?,'specialist',NULL,'active',?,'External coding helper','',NULL,NULL,NULL,'en',1,?,?)")
      .run(id, name, now, now);
    this.db.prepare("INSERT OR IGNORE INTO agent_workspaces VALUES (?,?,'managed',?,NULL,1,'unclassified',?)")
      .run(id, id, 'web/agents/' + id, now);
  }

  workspace(id: string) {
    return this.db.prepare('SELECT classification FROM agent_workspaces WHERE id=?').get(id)?.classification as Classification | undefined;
  }

  classifyWorkspace(id: string, label: Classification) {
    const current = this.workspace(id);
    this.assertLabel(current, label);
    if (current !== label) {
      this.db.prepare('UPDATE agent_workspaces SET classification=? WHERE id=?').run(label, id);
      this.db.prepare('INSERT INTO web_settings_audit(section,changed_at) VALUES (?,?)').run('external-classification:' + id, Date.now());
    }
  }

  workspaceRevision(id: string) {
    return Number(this.db.prepare('SELECT MAX(id) AS revision FROM web_settings_audit WHERE section=?')
      .get('external-classification:' + id)?.revision ?? 0);
  }

  vaultApproved(vault: string, revision: string, labelRevision: number) {
    return Boolean(this.db.prepare('SELECT 1 FROM web_settings_audit WHERE section=? LIMIT 1')
      .get('external-vault:' + JSON.stringify([vault, revision, labelRevision])));
  }

  approveVault(vault: string, revision: string, labelRevision: number) {
    if (!this.vaultApproved(vault, revision, labelRevision)) {
      this.db.prepare('INSERT INTO web_settings_audit(section,changed_at) VALUES (?,?)')
        .run('external-vault:' + JSON.stringify([vault, revision, labelRevision]), Date.now());
    }
  }

  source(sessionId: string, id: string) {
    const row = this.db.prepare('SELECT workspace_id AS workspaceId,descriptor FROM external_sources WHERE session_id=? AND id=?')
      .get(sessionId, id);
    if (row) return { id, sessionId, workspaceId: String(row.workspaceId), descriptor: JSON.parse(String(row.descriptor)) } as ExternalSource;
  }

  addSource(sessionId: string, workspaceId: string, value: SourceDescriptor) {
    const descriptor = JSON.stringify(value);
    this.db.prepare('INSERT OR IGNORE INTO external_sources VALUES (?,?,?,?,?)')
      .run(randomUUID(), sessionId, workspaceId, value.kind, descriptor);
    return String(this.db.prepare('SELECT id FROM external_sources WHERE session_id=? AND kind=? AND descriptor=?')
      .get(sessionId, value.kind, descriptor)!.id);
  }

  attachmentSource(sessionId: string, attachmentId: string) {
    return this.db.prepare("SELECT id FROM external_sources WHERE session_id=? AND kind='attachment' AND descriptor=?")
      .get(sessionId, JSON.stringify({ kind: 'attachment', attachmentId }))?.id as string | undefined;
  }

  sourceIds(sessionId: string) {
    return this.db.prepare('SELECT id FROM external_sources WHERE session_id=? ORDER BY rowid DESC LIMIT 100')
      .all(sessionId).map(({ id }) => String(id));
  }

  label(source: ExternalSource, sha256: string) {
    const [kind, id] = this.labelKey(source);
    return this.db.prepare('SELECT classification FROM file_classifications WHERE file_kind=? AND file_id=? AND workspace_id=? AND sha256=?')
      .get(kind, id, source.workspaceId, sha256)?.classification as Classification | undefined;
  }

  labelRevision(source: ExternalSource, sha256: string) {
    const [kind, id] = this.labelKey(source);
    return Number(this.db.prepare('SELECT updated_at FROM file_classifications WHERE file_kind=? AND file_id=? AND workspace_id=? AND sha256=?')
      .get(kind, id, source.workspaceId, sha256)?.updated_at ?? 0);
  }

  classify(source: ExternalSource, sha256: string, label: Classification) {
    this.assertLabel(this.label(source, sha256) ?? 'unclassified', label);
    if (this.label(source, sha256) === label) return;
    const [kind, id] = this.labelKey(source);
    this.db.prepare('INSERT OR REPLACE INTO file_classifications VALUES (?,?,?,?,?,?)')
      .run(kind, id, source.workspaceId, sha256, label, Math.max(Date.now(), this.labelRevision(source, sha256) + 1));
  }

  private labelKey({ id, descriptor }: ExternalSource): [string, string] {
    if (descriptor.kind === 'attachment') return ['attachment', descriptor.attachmentId];
    return [descriptor.kind === 'workspace' ? 'workspace' : 'artifact', id];
  }

  private assertLabel(current: Classification | undefined, label: Classification) {
    if (!current) throw new DelegationError('external-provenance-missing');
    if (current === 'confidential' && label !== 'confidential') throw new DelegationError('external-confidential');
  }

  snapshot(id: string) {
    const row = this.db.prepare('SELECT * FROM external_snapshots WHERE id=?').get(id);
    if (row) return { id, sessionId: row.session_id, parentRunId: row.parent_run_id, provider: row.provider,
      settingsRevision: row.settings_revision, digest: row.digest, manifest: JSON.parse(String(row.manifest)),
      content: row.content } as Snapshot;
  }

  saveSnapshot(snapshot: Snapshot) {
    this.db.prepare('INSERT INTO external_snapshots VALUES (?,?,?,?,?,?,?,?,?)').run(snapshot.id, snapshot.sessionId,
      snapshot.parentRunId, snapshot.provider, snapshot.settingsRevision, snapshot.digest, JSON.stringify(snapshot.manifest),
      snapshot.content, Date.now());
  }

  confirmation(id: string) {
    return this.db.prepare('SELECT snapshot_id AS snapshotId,expires_at AS expiresAt,challenge,decision,decided_at AS decidedAt FROM external_confirmations WHERE delegation_id=?')
      .get(id) as Confirmation | undefined;
  }

  addConfirmation(id: string, snapshotId: string, expiresAt: number, required: boolean, now: number) {
    this.db.prepare('INSERT INTO external_confirmations VALUES (?,?,?,?,?,?)')
      .run(id, snapshotId, expiresAt, randomUUID(), required ? null : 'owner_selection', required ? null : now);
  }

  confirm(id: string, now: number) {
    return Boolean(this.db.prepare("UPDATE external_confirmations SET decision='confirmed',decided_at=? WHERE delegation_id=? AND decision IS NULL AND expires_at>?")
      .run(now, id, now).changes);
  }
}
