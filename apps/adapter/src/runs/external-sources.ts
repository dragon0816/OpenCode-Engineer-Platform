import { randomUUID } from 'node:crypto';
import { relative, isAbsolute, sep } from 'node:path';
import { canonical, sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import type { KnowledgeStore } from '../../../../packages/knowledge/src/store.ts';
import type { ChatService } from '../http/chat.ts';
import { maxUpload, MiB } from './attachments.ts';
import { DelegationError, type Classification } from './delegation-ledger.ts';
import { helpers, type ExternalSource, type Provider, type Snapshot, type SnapshotFile, type SourceDescriptor } from './external-ledger.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';
import type { WebSession, WebStore } from './web-store.ts';

type Resolved = { file: SnapshotFile; data: Buffer; projection?: Buffer; label: Classification };
const strictest = (labels: Classification[]): Classification => labels.includes('confidential') ? 'confidential' :
  labels.every((label) => label === 'public') ? 'public' : 'unclassified';
const isInside = (root: string, path: string) => {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep);
};
const blockedName = /(?:^|\/)(?:\.(?:git|env|ssh|claude|codex)(?:[./]|$)|(?:AGENTS|CLAUDE)\.md(?:\/|$)|\.mcp\.json$|(?:credentials|secrets)(?:[./]|$))|\.(?:pem|pfx|key)$/i;
const blockedText = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[\s"'=])(?:sk-(?:proj-|ant-)?[a-z\d_-]{24,}|gh[pousr]_[a-z\d]{30,})\b/i;
const publicOnly = (label: Classification) => {
  if (label !== 'public') throw new DelegationError('external-' + label);
};

export class ExternalSources {
  private readonly store: WebStore;
  private readonly chat: Pick<ChatService, 'attachments' | 'workspace'>;
  private readonly root: string;
  private readonly knowledge?: KnowledgeStore;

  constructor(store: WebStore, chat: Pick<ChatService, 'attachments' | 'workspace'>, root: string, knowledge?: KnowledgeStore) {
    this.store = store;
    this.chat = chat;
    this.root = root;
    this.knowledge = knowledge;
  }

  private workspace(session: WebSession) {
    const owner = this.store.sessionOwner(session);
    if (!owner || owner.origin !== 'web') throw new DelegationError('external-provenance-missing');
    return owner.workspaceID;
  }

  register(session: WebSession, value: SourceDescriptor) {
    const workspace = this.workspace(session);
    if (value.kind === 'derived' && value.sources.some((id) => !this.store.external.source(session.id, id))) {
      throw new DelegationError('external-provenance-missing');
    }
    if (value.kind === 'attachment') throw new DelegationError('external-provenance-missing');
    const source = { id: '', sessionId: session.id, workspaceId: workspace, descriptor: value };
    this.read(session, source, new Map(), new Set());
    return this.store.external.addSource(session.id, workspace, value);
  }

  classify(session: WebSession, id: string, expectedHash: string, label: Classification) {
    const source = this.store.external.source(session.id, id);
    if (!source) throw new DelegationError('external-provenance-missing');
    const { file } = this.read(session, source, new Map(), new Set(), label === 'public');
    if (expectedHash !== file.sha256) throw new DelegationError('external-changed');
    this.store.external.classify(source, expectedHash, label);
    return this.inspect(session, id);
  }

  inspect(session: WebSession, id: string) {
    const source = this.store.external.source(session.id, id);
    if (!source) throw new DelegationError('external-provenance-missing');
    const { file, label } = this.read(session, source, new Map(), new Set());
    return { id, name: file.name, sha256: file.sha256, bytes: file.bytes, kind: file.kind, classification: label,
      ownClassification: this.store.external.label(source, file.sha256) ?? 'unclassified' };
  }

  list(session: WebSession) {
    return this.store.external.sourceIds(session.id).flatMap((id) => {
      try {
        const item = this.inspect(session, id);
        return item.kind === 'owner_text' ? [] : [item];
      } catch (error) {
        if (!(error instanceof DelegationError)) throw error;
        return [];
      }
    });
  }

  create(session: WebSession, runId: string, provider: Provider, taskId: string, inputs: string[]) {
    if (this.store.sessionOwner(session)?.agentID !== 'main' || this.store.turn(session.id, runId)) {
      throw new DelegationError('external-provenance-missing');
    }
    const settings = this.store.external.settings(provider);
    if (!settings.enabled) throw new DelegationError('external-disabled');
    const snapshot = this.collect(session, runId, provider, settings.revision, taskId, inputs);
    this.store.external.saveSnapshot(snapshot);
    return snapshot;
  }

  revalidate(session: WebSession, snapshot: Snapshot) {
    const settings = this.store.external.settings(snapshot.provider);
    if (!settings.enabled) throw new DelegationError('external-disabled');
    if (settings.revision !== snapshot.settingsRevision) throw new DelegationError('external-settings-changed');
    const current = this.collect(session, snapshot.parentRunId, snapshot.provider, settings.revision,
      snapshot.manifest.task.sourceId, snapshot.manifest.inputs.map(({ sourceId }) => sourceId), snapshot.manifest);
    if (current.digest !== snapshot.digest || !Buffer.from(snapshot.content).equals(Buffer.from(current.content))) {
      throw new DelegationError('external-changed');
    }
  }

  private collect(session: WebSession, parentRunId: string, provider: Provider, settingsRevision: number, task: string, inputs: string[],
    previous?: Snapshot['manifest']): Snapshot {
    const target = helpers[provider].id;
    publicOnly(this.store.external.workspace(target) ?? 'unclassified');
    const resolved = new Map<string, Resolved>();
    const entries = [task, ...inputs].map((id) => {
      const source = this.store.external.source(session.id, id);
      if (!source) throw new DelegationError('external-provenance-missing');
      return this.read(session, source, resolved, new Set());
    });
    const [taskFile, ...files] = entries.map(({ file }) => file);
    const hashes = (node: SnapshotFile): unknown => [node.sha256, node.projection?.sha256 ?? null, node.parents.map(hashes)];
    if (previous && JSON.stringify([previous.task, ...previous.inputs].map(hashes)) !== JSON.stringify([taskFile, ...files].map(hashes))) {
      throw new DelegationError('external-changed');
    }
    publicOnly(strictest(entries.map(({ label }) => label)));
    if (taskFile.kind !== 'owner_text' && taskFile.kind !== 'derived') throw new DelegationError('external-invalid-input');
    if (taskFile.bytes > 16_000 || new Set(files.map(({ name }) => name.toLowerCase())).size !== files.length) {
      throw new DelegationError('external-invalid-input');
    }
    const buffers = entries.flatMap(({ data, projection }) => projection ? [data, projection] : [data]);
    if (buffers.reduce((size, data) => size + data.length, 0) > 40 * MiB) throw new DelegationError('external-input-limit');
    const manifest = { task: taskFile, inputs: files };
    const digest = sha256(canonical({ manifest, session: session.id, parentRunId, provider, settingsRevision,
      targetRevision: this.store.external.workspaceRevision(target) }));
    return { id: randomUUID(), sessionId: session.id, parentRunId, provider, settingsRevision, digest, manifest, content: Buffer.concat(buffers) };
  }

  private read(session: WebSession, source: ExternalSource, cache: Map<string, Resolved>, chain: Set<string>, marking = false): Resolved {
    const prior = cache.get(source.id);
    if (prior) return prior;
    if (source.workspaceId !== this.workspace(session) || chain.has(source.id) || chain.size >= 5 || cache.size >= 24) {
      throw new DelegationError('external-provenance-missing');
    }
    chain.add(source.id);
    const { descriptor, workspaceId } = source;
    const parents: Resolved[] = [];
    let data: Buffer;
    let projection: Buffer | undefined;
    let name: string;
    let provenance: Record<string, unknown>;
    let rootLabel: Classification = 'public';
    if (descriptor.kind === 'attachment') {
      const id = descriptor.attachmentId;
      const record = this.store.attachment(session.id, id);
      if (!record) throw new DelegationError('external-provenance-missing');
      try {
        const result = this.chat.attachments.verifiedSelection(session.id, this.chat.workspace(session), [id]).next().value;
        if (!result) throw new Error('Missing attachment');
        ({ data, projection } = result);
      } catch { throw new DelegationError('external-changed'); }
      name = record.name;
      provenance = { attachmentId: id, mime: record.mime };
    } else if (descriptor.kind === 'workspace') {
      const workspace = this.store.agentWorkspaces(this.store.sessionOwner(session)!.agentID).find(({ id }) => id === workspaceId);
      const folder = workspace?.folders.find((value) => sha256(value) === descriptor.folder);
      if (!folder || isInside(this.root, folder) || blockedName.test(descriptor.path)) throw new DelegationError('external-provenance-missing');
      try {
        checkDirectory(folder);
        if (isInside(this.root, scopedPath(folder, descriptor.path))) throw new Error('Private path');
        const opened = openWorkspaceFile(folder, descriptor.path, maxUpload);
        data = opened.data;
        provenance = { folder: descriptor.folder, path: descriptor.path, identity: opened.identity };
      } catch { throw new DelegationError('external-changed'); }
      name = descriptor.path;
    } else if (descriptor.kind === 'citation') {
      const owner = this.store.sessionOwner(session)!;
      if (session.knowledgeDisabled === 1 || !this.store.knowledgeSettings().toolbox ||
          !this.store.executionKnowledgeReads(owner.agentID, workspaceId).includes(descriptor.vault)) {
        throw new DelegationError('external-provenance-missing');
      }
      const vault = this.knowledge?.vaultClassification(descriptor.vault);
      const citation = this.knowledge?.externalCitation(descriptor.vault, descriptor.revision, descriptor.passage);
      if (!vault || !citation) throw new DelegationError('external-provenance-missing');
      if (citation.sha256 !== descriptor.sha256) throw new DelegationError('external-changed');
      const { bytes, ...origin } = citation;
      data = bytes;
      name = source.id + '.txt';
      rootLabel = vault.label === 'public' && !this.store.external.vaultApproved(descriptor.vault, descriptor.revision, vault.revision)
        ? 'unclassified' : vault.label;
      provenance = { ...origin, vault: descriptor.vault, revision: descriptor.revision, passage: descriptor.passage, vaultRevision: vault.revision };
    } else {
      data = Buffer.from(descriptor.text);
      name = source.id + '.txt';
      if (descriptor.kind === 'derived') {
        for (const id of descriptor.sources) {
          const parent = this.store.external.source(session.id, id);
          if (!parent) throw new DelegationError('external-provenance-missing');
          parents.push(this.read(session, parent, cache, chain));
        }
        if (!parents.length) throw new DelegationError('external-provenance-missing');
      }
      provenance = { origin: descriptor.kind };
    }
    if (blockedName.test(name) || blockedText.test(data.toString('utf8')) || projection && blockedText.test(projection.toString('utf8'))) {
      throw new DelegationError('external-confidential');
    }
    const hash = sha256(data);
    const ledger = this.store.external;
    const inherited = strictest([ledger.workspace(workspaceId) ?? 'unclassified', rootLabel, ...parents.map(({ label }) => label)]);
    if (marking) publicOnly(inherited);
    const label = strictest([inherited, ledger.label(source, hash) ?? 'unclassified']);
    const result = { file: { sourceId: source.id, kind: descriptor.kind, name, sha256: hash, bytes: data.length,
      provenance: { ...provenance, workspaceId, workspaceRevision: ledger.workspaceRevision(workspaceId), labelRevision: ledger.labelRevision(source, hash) },
      parents: parents.map(({ file }) => file), ...(projection && { projection: { bytes: projection.length, sha256: sha256(projection) } }) },
    label, data, projection };
    chain.delete(source.id);
    cache.set(source.id, result);
    return result;
  }
}
