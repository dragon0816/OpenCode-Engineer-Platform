import { canonical, sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import type { Turn } from '../http/chat.ts';
import { MiB, type AttachmentService } from './attachments.ts';
import { DelegationError } from './delegation-ledger.ts';
import { helpers, type Provider, type Snapshot, type SnapshotFile } from './external-ledger.ts';
import { blockedExternalName, blockedExternalText, checkExternalLabel } from './external-sources.ts';
import type { WebSession, WebStore } from './web-store.ts';

export function externalTurnSnapshot(ledger: WebStore, store: WebStore, session: WebSession, provider: Provider,
  input: Turn, reply: { id: string; text: string } | undefined, attachments: AttachmentService, directory: string): Snapshot {
  const owner = store.sessionOwner(session);
  if (!owner || ledger.agentModelSource(owner.agentID) !== provider) throw new DelegationError('external-settings-changed');
  const settings = ledger.external.settings(provider);
  const policy = ledger.external.policy();
  if (!settings.enabled) throw new DelegationError('external-disabled');
  if (input.workbook) throw new DelegationError('external-workbook-unavailable');
  const target = helpers[provider].id;
  const workspaceLabel = ledger.external.workspace(owner.workspaceID) ?? 'unclassified';
  const qualify = (label: typeof workspaceLabel, name: string, ...buffers: Buffer[]) => {
    if (buffers.some((data) => blockedExternalText.test(data.toString('utf8')))) throw new DelegationError('external-confidential', name);
    checkExternalLabel(label, policy.strictMode, name);
  };
  qualify(ledger.external.workspace(target) ?? 'unclassified', helpers[provider].name);
  const text = Buffer.from(input.text);
  qualify(workspaceLabel, 'message', text);
  const quote = reply ? Buffer.from(reply.text) : undefined;
  // A prior answer may incorporate knowledge or file reads that are outside this turn's evidence.
  if (quote) {
    const prior = store.turns(session.id).find((run) => run.submissionID === reply!.id || run.id + '-external-reply' === reply!.id);
    if (prior?.external?.includesSources !== false) throw new DelegationError('external-reference-unverified');
    qualify(workspaceLabel, 'quoted message', quote);
  }
  const prompt = quote ? Buffer.concat([text, Buffer.from('\n\nQuoted message:\n'), quote]) : text;
  if (prompt.byteLength > 40 * MiB) throw new DelegationError('external-input-limit');
  const buffers: Buffer[] = [prompt];
  const files: SnapshotFile[] = [];
  const labels: string[] = [];
  let total = prompt.length;
  for (const id of input.attachments) {
    const attachment = store.attachment(session.id, id);
    if (!attachment) throw new DelegationError('external-changed', id);
    if (blockedExternalName.test(attachment.name)) throw new DelegationError('external-confidential', attachment.name);
    const label = ledger.delegations.attachmentClassification(owner.workspaceID, id, attachment.original.sha256);
    let selected: ReturnType<ReturnType<AttachmentService['verifiedSelection']>['next']>['value'];
    try { selected = attachments.verifiedSelection(session.id, directory, [id]).next().value; }
    catch { throw new DelegationError('external-changed', attachment.name); }
    if (!selected) throw new DelegationError('external-changed', attachment.name);
    const { data, projection } = selected;
    qualify(label, attachment.name, ...[data, projection].filter((item): item is Buffer => Boolean(item)));
    total += data.length + (projection?.length ?? 0);
    if (total > 40 * MiB) throw new DelegationError('external-input-limit');
    const extension = /\.[a-z0-9]{1,8}$/i.exec(attachment.name)?.[0] ?? '.txt';
    files.push({ sourceId: id, name: id + extension, kind: 'attachment', sha256: sha256(data), bytes: data.length,
      provenance: attachment.original, parents: [], ...(projection && { projection: { bytes: projection.length, sha256: sha256(projection) } }) });
    labels.push(label);
    buffers.push(data);
    if (projection) buffers.push(projection);
  }
  const manifest = { task: { sourceId: session.id, kind: 'owner_text' as const, name: 'message.txt', sha256: sha256(prompt),
    bytes: prompt.length, provenance: {}, parents: [] }, inputs: files };
  const digest = sha256(canonical({ manifest, provider, settings: settings.revision, policy: policy.revision, owner: owner.agentID,
    session: session.id, workspace: owner.workspaceID, workspaceLabel, labels, target, targetRevision: ledger.external.workspaceRevision(target),
    workspaceRevision: ledger.external.workspaceRevision(owner.workspaceID) }));
  return { id: input.id, sessionId: session.id, parentRunId: input.id, provider, settingsRevision: settings.revision, digest, manifest,
    content: Buffer.concat(buffers) };
}
