import { randomUUID } from 'node:crypto';
import { relative, isAbsolute, sep } from 'node:path';
import { canonical, sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import type { KnowledgeStore } from '../../../../packages/knowledge/src/store.ts';
import type { ChatService } from '../http/chat.ts';
import { maxUpload, MiB } from './attachments.ts';
import { DelegationError, type Classification } from './delegation-ledger.ts';
import { helpers, type ExternalSource, type Provider, type Snapshot, type SnapshotFile, type SourceDescriptor,
  type SourceSubmission } from './external-ledger.ts';
import type { LocalReferences } from './local-references.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';
import type { WebSession, WebStore } from './web-store.ts';

type Resolved = { file: SnapshotFile; data: Buffer; projection?: Buffer; label: Classification };
export const strictest = (labels: Classification[]): Classification => labels.includes('confidential') ? 'confidential' :
  labels.every((label) => label === 'public') ? 'public' : 'unclassified';
const isInside = (root: string, path: string) => {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep);
};
export const blockedExternalName = /(?:^|\/)(?:\.(?:git|env|ssh|claude|codex)(?:[./]|$)|(?:AGENTS|CLAUDE)\.md(?:\/|$)|\.mcp\.json$|(?:credentials|secrets)(?:[./]|$))|\.(?:pem|pfx|key)$/i;
export const blockedExternalText = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[\s"'=])(?:sk-(?:proj-|ant-)?[a-z\d_-]{24,}|gh[pousr]_[a-z\d]{30,})\b/i;
export const checkExternalLabel = (label: Classification, strictMode: boolean, name?: string) => {
  if (label === 'confidential') throw new DelegationError('external-confidential', name);
  if (strictMode && label === 'unclassified') throw new DelegationError('external-unclassified', name);
};
const sourceVersion = (file: SnapshotFile): string =>
  sha256(canonical([file.sourceId, file.sha256, file.projection?.sha256 ?? null, file.parents.map(sourceVersion)]));

export const maxExternalInput = 40 * MiB;
const maxReferences = 64;
export const externalExtension = (name: string) => /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] ?? '.txt';

export function collectExternalReferences(references: LocalReferences | undefined, session: string, ids: string[],
  workspaceLabel: Classification, strictMode: boolean, room: number) {
  const entries: Resolved[] = [];
  const revisions: string[] = [];
  for (const id of ids) {
    const reference = references?.get(session, id);
    if (!reference || !references) throw new DelegationError('external-changed', id);
    if (blockedExternalName.test(reference.name) || references.confidential(reference.path, reference)) {
      throw new DelegationError('external-confidential', reference.name);
    }
    const label = strictest([workspaceLabel, reference.classification]);
    checkExternalLabel(label, strictMode, reference.name);
    const selection = references.externalSelection(reference, room, maxUpload, maxReferences - entries.length);
    if ('error' in selection) throw new DelegationError(selection.error === 'external-input-limit' ? selection.error : 'external-changed', reference.name);
    for (const { path, identity, data: encoded } of selection.files) {
      const displayName = path ? `${reference.name}/${path}` : reference.name;
      const data = Buffer.from(encoded, 'base64');
      if (blockedExternalName.test(displayName) || blockedExternalText.test(data.toString('utf8'))) {
        throw new DelegationError('external-confidential', displayName);
      }
      room -= data.length;
      entries.push({ file: { sourceId: id, name: `${id}-${entries.length + 1}${externalExtension(displayName)}`, displayName,
        kind: 'local_reference', sha256: sha256(data), bytes: data.length,
        provenance: { revision: reference.revision, identity }, parents: [] }, data, label });
    }
    revisions.push(`${reference.revision}:${label}`);
  }
  return { entries, revisions };
}

export class ExternalSources {
  private readonly store: WebStore;
  private readonly chat: Pick<ChatService, 'attachments' | 'workspace' | 'references'>;
  private readonly root: string;
  private readonly knowledge?: KnowledgeStore;

  constructor(store: WebStore, chat: Pick<ChatService, 'attachments' | 'workspace' | 'references'>, root: string, knowledge?: KnowledgeStore) {
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

  register(session: WebSession, value: SourceSubmission) {
    const workspace = this.workspace(session);
    if (value.kind === 'attachment') throw new DelegationError('external-provenance-missing');
    const cache = new Map<string, Resolved>();
    const descriptor: SourceDescriptor = value.kind !== 'derived' ? value : { ...value, sourceVersions: value.sources.map((id) => {
      const parent = this.store.external.source(session.id, id);
      if (!parent) throw new DelegationError('external-provenance-missing');
      return sourceVersion(this.read(session, parent, cache, new Set()).file);
    }) };
    const source = { id: '', sessionId: session.id, workspaceId: workspace, descriptor };
    this.read(session, source, cache, new Set());
    return this.store.external.addSource(session.id, workspace, descriptor);
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
    const { descriptor } = source;
    const name = descriptor.kind === 'citation' ? [descriptor.vault, descriptor.passage].join(' · ') : file.name;
    return { id, name, sha256: file.sha256, bytes: file.bytes, kind: file.kind, classification: label,
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

  createForDelegation(session: WebSession, runId: string, provider: Provider, task: string, attachmentIds: string[], targetAgent?: string) {
    if (this.store.sessionOwner(session)?.agentID !== 'main' || this.store.turn(session.id, runId)?.run.state !== 'running') {
      throw new DelegationError('external-provenance-missing');
    }
    const settings = this.store.external.settings(provider);
    if (!settings.enabled) throw new DelegationError('external-disabled');
    const taskId = this.register(session, { kind: 'owner_text', text: task });
    if (this.store.external.workspace(this.workspace(session)) === 'public') {
      const { sha256, ownClassification } = this.inspect(session, taskId);
      if (ownClassification !== 'confidential') this.classify(session, taskId, sha256, 'public');
    }
    const referenceIds: string[] = [];
    const inputs = attachmentIds.flatMap((id) => {
      const source = this.store.external.attachmentSource(session.id, id);
      if (source) return [source];
      if (!this.chat.references?.get(session.id, id)) throw new DelegationError('external-provenance-missing');
      referenceIds.push(id);
      return [];
    });
    const snapshot = this.collect(session, runId, provider, settings.revision, taskId, inputs, undefined, targetAgent, referenceIds);
    this.store.external.saveSnapshot(snapshot);
    return snapshot;
  }

  revalidate(session: WebSession, snapshot: Snapshot, targetAgent?: string) {
    const settings = this.store.external.settings(snapshot.provider);
    if (snapshot.provider === 'claude_code' && !settings.termsConfirmed) throw new DelegationError('external-terms-required');
    if (!settings.enabled) throw new DelegationError('external-disabled');
    if (settings.revision !== snapshot.settingsRevision) throw new DelegationError('external-settings-changed');
    const current = this.collect(session, snapshot.parentRunId, snapshot.provider, settings.revision,
      snapshot.manifest.task.sourceId, snapshot.manifest.inputs.filter(({ kind }) => kind !== 'local_reference')
        .map(({ sourceId }) => sourceId), snapshot.manifest, targetAgent, snapshot.manifest.referenceIds);
    if (current.digest !== snapshot.digest || !Buffer.from(snapshot.content).equals(Buffer.from(current.content))) {
      throw new DelegationError('external-changed');
    }
  }

  private collect(session: WebSession, parentRunId: string, provider: Provider, settingsRevision: number, task: string, inputs: string[],
    previous?: Snapshot['manifest'], targetAgent?: string, referenceIds: string[] = []): Snapshot {
    const target = helpers[provider].id;
    const policy = this.store.external.policy();
    checkExternalLabel(this.store.external.workspace(target) ?? 'unclassified', policy.strictMode, helpers[provider].name);
    const workspace = targetAgent && this.store.defaultWorkspace(targetAgent);
    if (targetAgent && (!workspace || this.store.agentModelSource(targetAgent) !== provider)) {
      throw new DelegationError('external-settings-changed');
    }
    if (workspace) checkExternalLabel(this.store.external.workspace(workspace) ?? 'unclassified', policy.strictMode, 'specialist workspace');
    const resolved = new Map<string, Resolved>();
    const entries = [task, ...inputs].map((id) => {
      const source = this.store.external.source(session.id, id);
      if (!source) throw new DelegationError('external-provenance-missing');
      return this.read(session, source, resolved, new Set());
    });
    const [taskFile, ...files] = entries.map(({ file }) => file);
    if (previous) {
      const before = [previous.task, ...previous.inputs];
      const changed = [taskFile, ...files].find((file, index) => sourceVersion(file) !== sourceVersion(before[index]));
      if (changed) throw new DelegationError('external-changed', changed.kind === 'owner_text' ? undefined : changed.name);
    }
    for (const { label, file } of entries) checkExternalLabel(label, policy.strictMode, file.kind === 'owner_text' ? undefined : file.name);
    if (taskFile.kind !== 'owner_text' && taskFile.kind !== 'derived') throw new DelegationError('external-invalid-input');
    const buffers = entries.flatMap(({ data, projection }) => projection ? [data, projection] : [data]);
    const remaining = maxExternalInput - buffers.reduce((size, data) => size + data.length, 0);
    if (remaining < 0) throw new DelegationError('external-input-limit');
    const originLabel = this.store.external.workspace(this.workspace(session)) ?? 'unclassified';
    const references = collectExternalReferences(this.chat.references, session.id, referenceIds, originLabel, policy.strictMode, remaining);
    for (const { file, data } of references.entries) { files.push(file); buffers.push(data); }
    if (taskFile.bytes > 16_000 || new Set(files.map(({ name }) => name.toLowerCase())).size !== files.length) {
      throw new DelegationError('external-invalid-input');
    }
    const manifest = { task: taskFile, inputs: files, ...(referenceIds.length && { referenceIds }) };
    const digest = sha256(canonical({ manifest, session: session.id, parentRunId, provider, settingsRevision,
      targetRevision: this.store.external.workspaceRevision(target), policyRevision: policy.revision,
      ...(referenceIds.length && { referenceRevisions: references.revisions }),
      ...(workspace && { targetAgent, targetWorkspaceRevision: this.store.external.workspaceRevision(workspace) }) }));
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
      } catch { throw new DelegationError('external-changed', record.name); }
      name = record.name;
      provenance = { attachmentId: id, mime: record.mime };
    } else if (descriptor.kind === 'workspace') {
      const workspace = this.store.agentWorkspaces(this.store.sessionOwner(session)!.agentID).find(({ id }) => id === workspaceId);
      const folder = workspace?.folders.find((value) => sha256(value) === descriptor.folder);
      if (!folder || isInside(this.root, folder) || blockedExternalName.test(descriptor.path)) throw new DelegationError('external-provenance-missing');
      let path: string;
      try { path = scopedPath(folder, descriptor.path); }
      catch { throw new DelegationError('external-changed'); }
      if (this.chat.references?.confidential(path)) throw new DelegationError('external-confidential');
      try {
        checkDirectory(folder);
        if (isInside(this.root, path)) throw new Error('Private path');
        const opened = openWorkspaceFile(folder, descriptor.path, maxUpload);
        data = opened.data;
        provenance = { folder: descriptor.folder, path: descriptor.path, identity: opened.identity };
      } catch { throw new DelegationError('external-changed', descriptor.path); }
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
        if (!parents.length || descriptor.sourceVersions?.length !== parents.length) throw new DelegationError('external-provenance-missing');
        if (parents.some(({ file }, index) => descriptor.sourceVersions[index] !== sourceVersion(file))) {
          throw new DelegationError('external-changed');
        }
      }
      provenance = { origin: descriptor.kind };
    }
    if (blockedExternalName.test(name) || blockedExternalText.test(data.toString('utf8')) || projection && blockedExternalText.test(projection.toString('utf8'))) {
      throw new DelegationError('external-confidential', descriptor.kind === 'owner_text' ? undefined : name);
    }
    const hash = sha256(data);
    const ledger = this.store.external;
    const inherited = strictest([ledger.workspace(workspaceId) ?? 'unclassified', rootLabel, ...parents.map(({ label }) => label)]);
    if (marking) checkExternalLabel(inherited, true, descriptor.kind === 'owner_text' ? undefined : name);
    const label = strictest([inherited, ledger.label(source, hash) ?? 'unclassified']);
    const cacheBytes = [...cache.values()].reduce((size, value) => size + value.data.length + (value.projection?.length ?? 0), 0);
    if (cacheBytes + data.length + (projection?.length ?? 0) > 80 * MiB) throw new DelegationError('external-input-limit');
    const result = { file: { sourceId: source.id, kind: descriptor.kind, name, sha256: hash, bytes: data.length,
      provenance: { ...provenance, workspaceId, workspaceRevision: ledger.workspaceRevision(workspaceId), labelRevision: ledger.labelRevision(source, hash) },
      parents: parents.map(({ file }) => file), ...(projection && { projection: { bytes: projection.length, sha256: sha256(projection) } }) },
    label, data, projection };
    chain.delete(source.id);
    cache.set(source.id, result);
    return result;
  }
}
