import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttachmentService } from '../../apps/adapter/src/runs/attachments.ts';
import { Dispatcher } from '../../apps/adapter/src/runs/dispatcher.ts';
import { ExternalDelegations } from '../../apps/adapter/src/runs/external-delegations.ts';
import { helpers, type Snapshot } from '../../apps/adapter/src/runs/external-ledger.ts';
import { ExternalSources } from '../../apps/adapter/src/runs/external-sources.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { canonicalWorkspaceDirectory } from '../../apps/adapter/src/runs/workspace.ts';
import { canonical, sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';

const code = (name: string) => ({ code: 'external-' + name });
const provider = 'codex_cli';
const specialistId = helpers[provider].id;

test('external helpers default off and Claude requires persisted owner terms confirmation', () => {
  const folder = mkdtempSync(join(tmpdir(), 'oep-helper-settings-'));
  const path = join(folder, 'web.sqlite');
  let store = new WebStore(path);
  try {
    const codex = store.external.settings(provider);
    const claude = store.external.settings('claude_code');
    assert.equal(codex.enabled, false);
    assert.equal(claude.enabled, false);
    assert.equal(codex.confirmEachRun, false);
    assert.equal(claude.confirmEachRun, false);
    assert.deepEqual(store.external.policy(), { strictMode: false, revision: 0 });
    assert.throws(() => store.external.saveSettings({ ...claude, enabled: true }), code('terms-required'));
    const saved = store.external.saveSettings({ ...codex, enabled: true, confirmEachRun: true });
    const strict = store.external.savePolicy(true, 0);
    store.external.saveSettings({ ...claude, enabled: true, termsConfirmed: true });
    assert.throws(() => store.external.saveSettings({ ...codex, enabled: false }), code('settings-changed'));
    store.close();
    store = new WebStore(path);
    assert.deepEqual(store.external.settings(provider), saved);
    assert.deepEqual(store.external.policy(), strict);
    assert.equal(store.external.settings('claude_code').termsConfirmed, true);
    assert.equal(store.external.settings('claude_code').enabled, true);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('public snapshots pin selected bytes, inherit provenance, and release only the confirmed synthetic run', async () => {
  const folder = canonicalWorkspaceDirectory(mkdtempSync(join(tmpdir(), 'oep-external-')));
  const root = join(folder, 'web');
  const project = join(folder, 'public-example');
  const workspace = join(root, 'session');
  mkdirSync(join(workspace, 'attachments'), { recursive: true });
  mkdirSync(project);
  const store = new WebStore(join(root, 'web.sqlite'));
  const knowledge = new KnowledgeStore(join(root, 'knowledge.sqlite'));
  const dispatcher = new Dispatcher(store.workItems);
  try {
    const session = { project: 'default' as const, id: randomUUID(), upstreamID: 'synthetic-parent', createdAt: Date.now(),
      agent: 'inspector' as const, alias: 'synthetic' };
    store.createSession(session);
    const attachmentService = new AttachmentService(store);
    const sources = new ExternalSources(store, { attachments: attachmentService, workspace: () => workspace }, root, knowledge);
    const sent: Snapshot[] = [];
    const delegations = new ExternalDelegations(store, dispatcher, sources, () => {}, { synthetic: (snapshot) => { sent.push(snapshot); } });
    const ledger = store.external;
    ledger.ensureTarget(provider);
    ledger.saveSettings({ ...ledger.settings(provider), enabled: true, confirmEachRun: true });
    const setStrict = (strict: boolean) => ledger.savePolicy(strict, ledger.policy().revision);
    setStrict(true);
    ledger.classifyWorkspace(specialistId, 'public');
    ledger.classifyWorkspace('legacy-default', 'public');
    store.addProjectFolder('default', project);
    const taskText = 'Synthetic owner task';
    const task = sources.register(session, { kind: 'owner_text', text: taskText });
    const mark = (id: string) => sources.classify(session, id, sources.inspect(session, id).sha256, 'public');
    const prepare = (inputs: string[] = [], runId = randomUUID()) => sources.create(session, runId, provider, task, inputs);
    assert.throws(() => prepare(), code('unclassified'));
    setStrict(false);
    assert.equal(prepare().manifest.task.sha256, sha256(taskText));
    setStrict(true);
    mark(task);
    const fileBytes = Buffer.from('Synthetic example before editing');
    const path = join(project, 'example.txt');
    writeFileSync(path, fileBytes);
    const file = sources.register(session, { kind: 'workspace', folder: sha256(project), path: 'example.txt' });
    assert.throws(() => prepare([file]), code('unclassified'));
    mark(file);
    assert.throws(() => prepare([randomUUID()]), code('provenance-missing'));
    assert.throws(() => sources.register(session, { kind: 'derived', text: 'Unknown source', sources: [randomUUID()] }),
      code('provenance-missing'));
    const bytes = Buffer.from('Synthetic attachment material');
    const uploaded = await attachmentService.upload(session.id, workspace, 'source.txt', 'text/plain', bytes.length, async () => bytes);
    const attachment = ledger.attachmentSource(session.id, uploaded.id)!;
    assert.throws(() => prepare([attachment]), code('unclassified'));
    mark(attachment);
    const derived = sources.register(session, { kind: 'derived', text: 'Derived synthetic text', sources: [file, attachment] });
    mark(derived);
    assert.equal(sources.inspect(session, derived).classification, 'public');
    const second = await attachmentService.upload(session.id, workspace, 'confidential.txt', 'text/plain', bytes.length, async () => bytes);
    const confidential = ledger.attachmentSource(session.id, second.id)!;
    sources.classify(session, confidential, second.sha256, 'confidential');
    assert.throws(() => prepare([confidential]), { ...code('confidential'), item: 'confidential.txt' });
    assert.throws(() => mark(confidential), code('confidential'));
    const restricted = sources.register(session, { kind: 'derived', text: 'Derived from confidential', sources: [derived, confidential] });
    assert.equal(sources.inspect(session, restricted).classification, 'confidential');
    assert.throws(() => mark(restricted), code('confidential'));
    assert.throws(() => prepare([restricted]), code('confidential'));
    setStrict(false);
    assert.throws(() => prepare([confidential]), { ...code('confidential'), item: 'confidential.txt' });
    assert.throws(() => prepare([restricted]), code('confidential'));
    setStrict(true);

    const { snapshot: publication } = goldFixture();
    publication.sources.forEach((source) => { source.sha256 = sha256(source.id); });
    knowledge.import(publication, Buffer.from(canonical(publication)), true);
    const vault = publication.vault.id;
    const revision = publication.publication.revision;
    store.updateAgent('main', store.agents().find(({ id }) => id === 'main')!.revision, { knowledgeReads: [vault] }, 'available');
    const passage = publication.passages[0];
    const citation = sources.register(session, { kind: 'citation', vault, revision, passage: passage.id, sha256: passage.sha256 });
    assert.throws(() => mark(citation), code('unclassified'));
    assert.equal(knowledge.classifyVault(vault, revision, 'public'), 'saved');
    ledger.approveVault(vault, revision, knowledge.vaultClassification(vault)!.revision);
    mark(citation);
    store.saveKnowledgeSettings('', false);
    assert.throws(() => prepare([citation]), code('provenance-missing'));
    store.saveKnowledgeSettings('', true);

    const snapshot = prepare([file, attachment, derived, citation]);
    assert.equal(snapshot.manifest.inputs[0].sha256, sha256(fileBytes));
    assert.deepEqual(snapshot.manifest.inputs[2].parents.map(({ sourceId }) => sourceId), [file, attachment]);
    assert.deepEqual(Buffer.from(snapshot.content),
      Buffer.concat([Buffer.from(taskText), fileBytes, bytes, Buffer.from('Derived synthetic text'), Buffer.from(passage.text)]));
    const admit = (value = snapshot, target: string = specialistId) => delegations.admit(session, value.parentRunId,
      { specialistId: target, publicInputId: value.id, requestKey: randomUUID() });
    assert.throws(() => admit(snapshot, helpers.claude_code.id), code('provenance-missing'));
    const waiting = admit();
    assert.equal(waiting.status, 'awaiting_confirmation');
    const id = waiting.delegationId;
    assert.equal(admit().delegationId, id);
    const { challenge, digest, settingsRevision, parentRunId } = delegations.ownerDetails(id)!;
    const confirmation = { provider, challenge, digest, settingsRevision, parentRunId };
    for (const overrides of [{ provider: 'claude_code' }, { digest: sha256('wrong') }, { settingsRevision: 1 }, { parentRunId: randomUUID() },
      { challenge: randomUUID() }]) {
      assert.throws(() => delegations.confirm(id, { ...confirmation, ...overrides }), code('confirmation-invalid'));
    }
    const expires = ledger.confirmation(id)!.expiresAt;
    assert.throws(() => delegations.confirm(id, confirmation, expires), code('confirmation-expired'));
    assert.equal(store.workItems.claim(() => true), undefined);
    const beforeChange = prepare([file]);
    const changeId = admit(beforeChange).delegationId;
    const changeDetails = delegations.ownerDetails(changeId)!;
    writeFileSync(path, 'Synthetic changed file');
    const binding = (value: typeof changeDetails) => ({ provider: value.provider, parentRunId: value.parentRunId,
      challenge: value.challenge, digest: value.digest, settingsRevision: value.settingsRevision });
    assert.throws(() => delegations.confirm(changeId, binding(changeDetails)), code('changed'));
    assert.throws(() => delegations.confirm(id, confirmation), code('changed'));
    assert.throws(() => prepare([derived]), code('changed'));
    const original = await attachmentService.upload(session.id, workspace, 'altered.txt', 'text/plain', bytes.length, async () => bytes);
    const altered = ledger.attachmentSource(session.id, original.id)!;
    mark(altered);
    writeFileSync(join(workspace, 'attachments', original.id + '.source'), 'Synthetic changed attachment');
    assert.throws(() => prepare([altered]), code('changed'));
    assert.equal(sent.length, 0);
    mark(file);
    assert.throws(() => mark(derived), code('changed'));
    const replacement = prepare([file, attachment, citation]);
    const accepted = admit(replacement).delegationId;
    const approved = binding(delegations.ownerDetails(accepted)!);
    await dispatcher.start();
    assert.equal(sent.length, 0);
    assert.deepEqual(delegations.confirm(accepted, approved), { status: 'queued' });
    assert.throws(() => delegations.confirm(accepted, approved), code('confirmation-replayed'));
    await dispatcher.wait(store.delegations.get(accepted)!.workId);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].digest, replacement.digest);
    assert.equal(store.delegations.get(accepted)?.status, 'succeeded');
    const revisionChange = admit(prepare()).delegationId;
    const beforeSettings = binding(delegations.ownerDetails(revisionChange)!);
    store.external.saveSettings({ ...store.external.settings(provider), confirmEachRun: false });
    assert.throws(() => delegations.confirm(revisionChange, beforeSettings), code('settings-changed'));
    const withoutDialog = admit(prepare());
    assert.equal(withoutDialog.status, 'queued');
    assert.equal(ledger.confirmation(withoutDialog.delegationId)?.decision, 'owner_selection');
  } finally {
    await dispatcher.close();
    knowledge.close();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
