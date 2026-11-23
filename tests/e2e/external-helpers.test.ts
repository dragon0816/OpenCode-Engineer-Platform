import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttachmentService } from '../../apps/adapter/src/runs/attachments.ts';
import { DelegationService } from '../../apps/adapter/src/runs/delegation.ts';
import { Dispatcher } from '../../apps/adapter/src/runs/dispatcher.ts';
import { ExternalDelegations } from '../../apps/adapter/src/runs/external-delegations.ts';
import { ExternalExecutor } from '../../apps/adapter/src/runs/external-executor.ts';
import { helpers, type Provider } from '../../apps/adapter/src/runs/external-ledger.ts';
import { ExternalSources } from '../../apps/adapter/src/runs/external-sources.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { canonicalWorkspaceDirectory } from '../../apps/adapter/src/runs/workspace.ts';
import { sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import { restrictedJobFixture } from '../fixtures/external-helpers/isolation.ts';
import { memoryHelper } from '../fixtures/external-helpers/memory-cli.ts';
import { externalTurnSnapshot } from '../../apps/adapter/src/runs/external-turn.ts';
import { LocalReferences } from '../../apps/adapter/src/runs/local-references.ts';

test('direct external input policy names blocked attachments and rejects changes at the release handshake', async () => {
  const folder = canonicalWorkspaceDirectory(mkdtempSync(join(process.env.OEP_DATA_DIR!, 'direct-helper-')));
  const directory = join(folder, 'session');
  mkdirSync(join(directory, 'attachments'), { recursive: true });
  const store = new WebStore(join(folder, 'web.sqlite'));
  try {
    const provider = 'codex_cli';
    store.external.ensureTarget(provider);
    store.external.saveSettings({ ...store.external.settings(provider), enabled: true, confirmEachRun: true });
    store.updateAgent('main', store.agents().find(({ id }) => id === 'main')!.revision, { modelSource: provider }, 'available');
    store.external.classifyWorkspace(helpers[provider].id, 'public');
    store.external.classifyWorkspace('legacy-default', 'public');
    const session = { project: 'default' as const, id: randomUUID(), upstreamID: 'synthetic', createdAt: Date.now(),
      agent: 'inspector' as const, alias: 'synthetic' };
    store.createSession(session);
    const attachments = new AttachmentService(store);
    const sources = new ExternalSources(store, { attachments, workspace: () => directory }, folder);
    const data = Buffer.from('Synthetic attachment');
    const file = await attachments.upload(session.id, directory, 'notes.txt', 'text/plain', data.length, async () => data);
    const secret = await attachments.upload(session.id, directory, 'restricted.txt', 'text/plain', data.length, async () => data);
    sources.classify(session, store.external.attachmentSource(session.id, secret.id)!, secret.sha256, 'confidential');
    const input = { id: randomUUID(), text: 'Synthetic message', attachments: [file.id], workbook: false };
    const capture = () => externalTurnSnapshot(store, store, session, provider, input, undefined, attachments, directory);
    assert.equal(capture().manifest.inputs[0].sha256, file.sha256);
    input.attachments = [secret.id];
    assert.throws(capture, { code: 'external-confidential', item: 'restricted.txt' });
    input.attachments = [file.id];
    store.external.savePolicy(true, store.external.policy().revision);
    assert.throws(capture, { code: 'external-unclassified', item: 'notes.txt' });
    store.external.savePolicy(false, store.external.policy().revision);
    const confirmed = capture();
    const helper = memoryHelper(folder, () => writeFileSync(join(directory, 'attachments', file.id + '.source'), 'Synthetic mutation'));
    await assert.rejects(helper.executor.execute(confirmed, input.id, 2, new AbortController().signal, () => {},
      () => capture(), () => {}, () => capture()), { code: 'external-changed', item: 'notes.txt' });
    assert.equal(helper.launched.length, 0);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('external helpers stage only selected pinned references and fail closed on classification changes', async (t) => {
  const root = canonicalWorkspaceDirectory(mkdtempSync(join(process.env.OEP_DATA_DIR!, 'reference-helper-')));
  const files = canonicalWorkspaceDirectory(mkdtempSync(join(tmpdir(), 'oep-external-references-')));
  const directory = join(files, 'selected');
  mkdirSync(directory);
  const sample = join(directory, 'sample.txt');
  writeFileSync(sample, 'Synthetic selected content');
  writeFileSync(join(directory, '.env'), 'Synthetic disallowed control file');
  writeFileSync(join(files, 'unselected.txt'), 'Synthetic non-selected sibling');
  const store = new WebStore(join(root, 'web.sqlite'));
  t.after(() => {
    store.close();
    rmSync(files, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const provider = 'codex_cli';
  store.external.ensureTarget(provider);
  store.external.saveSettings({ ...store.external.settings(provider), enabled: true });
  store.updateAgent('main', store.agents().find(({ id }) => id === 'main')!.revision, { modelSource: provider }, 'available');
  const session = { project: 'default' as const, id: randomUUID(), upstreamID: 'synthetic', createdAt: Date.now(),
    agent: 'inspector' as const, alias: 'synthetic' };
  store.createSession(session);
  const references = new LocalReferences(store.references!, root);
  const [folder, file] = await references.attach(session.id, [directory, sample], () => true);
  const input = { id: randomUUID(), text: 'Synthetic question', attachments: [folder.id], workbook: false };
  const snapshot = () => externalTurnSnapshot(store, store, session, provider, input, undefined,
    new AttachmentService(store), root, references);
  const approved = snapshot();
  assert.deepEqual(approved.manifest.inputs.map(({ displayName }) => displayName), ['selected/sample.txt']);
  assert.equal(approved.manifest.inputs[0].sha256, sha256('Synthetic selected content'));
  const helper = memoryHelper(root);
  const result = await helper.executor.execute(approved, input.id, 2, new AbortController().signal,
    () => {}, () => {}, () => {}, () => {});
  const staged = join(result.copyDirectory, 'work', 'oep-inputs');
  assert.deepEqual(readdirSync(staged), [approved.manifest.inputs[0].name]);
  assert.equal(readFileSync(join(staged, approved.manifest.inputs[0].name), 'utf8'), 'Synthetic selected content');
  assert.ok(!helper.launched[0].includes(files));

  store.external.classifyWorkspace(helpers[provider].id, 'public');
  store.external.classifyWorkspace('legacy-default', 'public');
  store.external.savePolicy(true, store.external.policy().revision);
  assert.throws(snapshot, { code: 'external-unclassified', item: 'selected' });
  references.classify(session.id, folder, 'public');
  assert.equal(snapshot().manifest.inputs.length, 1);
  input.id = randomUUID();
  const beforeRelease = snapshot();
  const blocked = memoryHelper(root, () => references.classify(session.id, file, 'confidential'));
  await assert.rejects(blocked.executor.execute(beforeRelease, input.id, 2, new AbortController().signal, () => {},
    () => snapshot(), () => {}, () => {}), { code: 'external-confidential', item: 'selected' });
  assert.equal(blocked.launched.length, 0);
  assert.equal(existsSync(join(root, 'agents', helpers[provider].id, 'external', input.id)), false);
  input.attachments = [file.id];
  assert.throws(snapshot, { code: 'external-confidential', item: 'sample.txt' });
});

test('external CLI jobs use synthetic Windows restricted tokens and settle the delegation lease', { timeout: 180_000 }, async (t) => {
  const folder = canonicalWorkspaceDirectory(mkdtempSync(join(process.env.OEP_DATA_DIR!, 'helper-suite-')));
  const root = join(folder, 'web');
  const project = join(folder, 'project');
  const workspace = join(root, 'session');
  mkdirSync(join(workspace, 'attachments'), { recursive: true });
  mkdirSync(join(project, 'folder'), { recursive: true });
  const store = new WebStore(join(root, 'web.sqlite'));
  const dispatcher = new Dispatcher(store.workItems);
  const attachmentService = new AttachmentService(store);
  const sources = new ExternalSources(store, { attachments: attachmentService, workspace: () => workspace }, root);
  const original = 'Synthetic original\n';
  const path = join(project, 'folder', 'Example.txt');
  writeFileSync(path, original);
  const session = { project: 'default' as const, id: randomUUID(), upstreamID: 'synthetic-parent', createdAt: Date.now(),
    agent: 'inspector' as const, alias: 'synthetic' };
  const syntheticVariables = ['OEP_GATEWAY_KEY', 'OEP_TELEGRAM_TEST_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS'];
  const saved = syntheticVariables.map((variable) => process.env[variable]);
  for (const variable of syntheticVariables) process.env[variable] = 'synthetic-environment-canary';
  try {
    const fake = restrictedJobFixture(folder);
    const executor = new ExternalExecutor(root, fake.isolation);
    const external = new ExternalDelegations(store, dispatcher, sources, () => {}, { executor });
    const delegations = new DelegationService(store, root, dispatcher);
    delegations.registerExternal(external);
    store.createSession(session);
    store.external.classifyWorkspace('legacy-default', 'public');
    store.addProjectFolder('default', project);
    const file = sources.register(session, { kind: 'workspace', folder: sha256(project), path: 'folder/Example.txt' });
    const mark = (id: string) => sources.classify(session, id, sources.inspect(session, id).sha256, 'public');
    mark(file);
    const ref = Buffer.from('Synthetic read-only reference');
    const attachment = await attachmentService.upload(session.id, workspace, 'reference.txt', 'text/plain', ref.length, async () => ref);
    const reference = store.external.attachmentSource(session.id, attachment.id)!;
    mark(reference);
    store.delegations.saveBudgets({ ...store.delegations.budgets(), modelRequestsPerDelegation: 2 });
    const intake = (provider: Provider, task: string, inputs = [file, reference]) => {
      const taskId = sources.register(session, { kind: 'owner_text', text: 'Synthetic owner task ' + task });
      mark(taskId);
      const snapshot = sources.create(session, randomUUID(), provider, taskId, inputs);
      const receipt = external.admit(session, snapshot.parentRunId, {
        specialistId: helpers[provider].id, publicInputId: snapshot.id, requestKey: randomUUID(),
      });
      const id = receipt.delegationId;
      const { challenge, digest, settingsRevision, parentRunId } = external.ownerDetails(id)!;
      const { workId } = store.delegations.get(id)!;
      const { runId } = store.workItems.get(workId)!;
      const copy = join(root, 'agents', helpers[provider].id, 'external', runId!);
      return { id, workId, copy, confirm: () => external.confirm(id, { provider, challenge, digest, settingsRevision, parentRunId }) };
    };
    const settle = async ({ id, workId }: ReturnType<typeof intake>) => {
      await dispatcher.wait(workId);
      return store.delegations.inspect(id)!;
    };
    const readDescendants = async (copy: string) => {
      const marker = join(copy, 'work', 'child-ready.txt');
      try {
        const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[];
        if (pids.length === 2 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)) return pids;
      } catch { /* Wait for the fake child to complete the marker. */ }
    };

    await t.test('isolation, installation, exact version and login determine readiness', async () => {
      fake.mode('unavailable');
      assert.equal((await external.refresh('codex_cli')).isolation, 'unavailable');
      assert.throws(() => external.requiresReady('codex_cli'), { code: 'external-isolation-unavailable' });
      fake.mode('missing');
      assert.equal((await external.refresh('codex_cli')).installation, 'missing');
      fake.mode('signed-out');
      const status = await external.refresh('claude_code');
      assert.deepEqual(status, { installation: 'detected', isolation: 'verified', version: '1.2.3', pinnedVersion: '1.2.3', login: 'signedOut' },
        fake.failures.at(-1) ?? JSON.stringify(fake.receipts.at(-1)));
      assert.throws(() => external.requiresReady('claude_code'), { code: 'external-cli-login-unavailable' });
      fake.mode('normal');
      for (const provider of ['codex_cli', 'claude_code'] as const) {
        assert.equal((await external.refresh(provider)).login, 'signedIn');
        store.external.ensureTarget(provider);
        store.external.classifyWorkspace(helpers[provider].id, 'public');
        if (provider === 'claude_code') {
          assert.throws(() => store.external.saveSettings({ ...store.external.settings(provider), enabled: true }), { code: 'external-terms-required' });
        }
        store.external.saveSettings({ ...store.external.settings(provider), enabled: true, confirmEachRun: true,
          termsConfirmed: provider === 'claude_code' });
      }
    });

    await t.test('hash changed after confirmation is rejected before any CLI job is released', async () => {
      const job = intake('codex_cli', 'probe boundaries');
      job.confirm();
      writeFileSync(path, 'Synthetic changed after approval');
      await dispatcher.start();
      const detail = await settle(job);
      assert.equal(detail.receipt.status, 'failed');
      assert.equal(detail.result && detail.result.reasonCode, 'external-changed');
      assert.equal(fake.launches(), 0);
      assert.equal(store.delegations.get(job.id)!.usedRequests, 0);
      assert.equal(existsSync(job.copy), false);
      writeFileSync(path, original);
      mark(file);
    });

    await t.test('both CLIs see scrubbed environments and read-only input, then record verified changes', async () => {
      for (const provider of ['codex_cli', 'claude_code'] as const) {
        const job = intake(provider, 'probe boundaries grandchildren');
        job.confirm();
        const info = await settle(job);
        const receipt = fake.receipts.at(-1);
        assert.equal(info.receipt.status, 'succeeded', JSON.stringify({ result: info.result, exit: receipt?.exit, diagnosis: receipt?.diagnosis }));
        const descendants = JSON.parse(readFileSync(join(job.copy, 'work', 'child-ready.txt'), 'utf8')) as number[];
        assert.equal(descendants.length, 2);
        assert.ok(descendants.every((pid) => fake.receipts.at(-1)?.observed.includes(pid)));
        assert.ok((info.events.find(({ reasonCode }) => reasonCode === 'external-job-stopped')?.metrics?.members ?? 0) >= 3);
        assert.equal(info.events.find(({ reasonCode }) => reasonCode === 'external-job-stopped')?.metrics?.orphans, 0);
        const row = store.delegations.get(job.id)!;
        assert.equal(row.usedRequests, row.reservedRequests);
        assert.equal(row.usedTools, row.reservedTools);
        const manifest = readFileSync(join(job.copy, 'changed-files.json'));
        assert.equal(info.result && info.result.changes?.manifestSha256, sha256(manifest));
        assert.equal(info.result && info.result.changes?.count, 3);
        assert.deepEqual(JSON.parse(manifest.toString()).find(({ path: name }: { path: string }) => name === 'folder/Example.txt'),
          { path: 'folder/Example.txt', before: sha256(original), after: sha256('Synthetic verified modification\r\n') });
        assert.equal(readFileSync(path, 'utf8'), original);
        assert.equal(readFileSync(fake.canary, 'utf8'), 'Synthetic private canary');
        assert.equal(existsSync(join(job.copy, 'scratch')), false);
      }
    });

    await t.test('floods, malformed output, nonzero exit and alternate streams publish no changes', async () => {
      for (const [task, reason] of [['output flood', 'external-cli-output-limit'], ['bad output', 'external-cli-invalid-output'],
        ['nonzero', 'external-cli-failed'], ['alternate stream', 'external-copy-unsafe']]) {
        const job = intake('codex_cli', task);
        job.confirm();
        const result = (await settle(job)).result;
        assert.equal(result && result.reasonCode, reason);
        assert.equal(existsSync(job.copy), false);
        assert.equal(fake.receipts.at(-1)?.orphans, 0);
      }
    });

    await t.test('owner cancel terminates a live grandchild, then deadline kills a hanging CLI', async () => {
      const cancelled = intake('claude_code', 'grandchildren hang');
      cancelled.confirm();
      const descendants = await until(() => readDescendants(cancelled.copy), 20_000);
      await delegations.cancel(cancelled.id);
      const result = (await settle(cancelled)).result;
      assert.equal(result && result.status, 'cancelled');
      assert.equal(descendants.length, 2);
      assert.ok(descendants.every((pid) => fake.receipts.at(-1)?.observed.includes(pid)));
      assert.ok((fake.receipts.at(-1)?.members ?? 0) >= 3);
      assert.equal(fake.receipts.at(-1)?.orphans, 0);
      assert.equal(existsSync(cancelled.copy), false);
      const budgets = store.delegations.budgets();
      store.delegations.saveBudgets({ ...budgets, executionMsPerDelegation: 15_000 });
      const stalled = intake('codex_cli', 'hang');
      stalled.confirm();
      const timeout = (await settle(stalled)).result;
      assert.equal(timeout && timeout.status, 'timed_out');
      assert.equal(fake.receipts.at(-1)?.exit, null);
      assert.equal(fake.receipts.at(-1)?.orphans, 0);
      assert.equal(existsSync(stalled.copy), false);
      store.delegations.saveBudgets(budgets);
    });

    await t.test('zero tool budget and binary tampering block launch', async () => {
      const count = fake.launches();
      const limits = store.turnLimits();
      store.saveTurnLimits({ ...limits, toolCalls: 0 });
      const blocked = intake('codex_cli', 'zero tools');
      blocked.confirm();
      const result = (await settle(blocked)).result;
      assert.equal(result && result.reasonCode, 'external-budget-unavailable');
      assert.equal(fake.launches(), count);
      assert.equal(store.delegations.get(blocked.id)!.usedTools, 0);
      store.saveTurnLimits(limits);
      const originalBinary = readFileSync(fake.script);
      appendFileSync(fake.script, '\n// Synthetic replacement');
      assert.equal((await external.refresh('codex_cli')).installation, 'unsupported');
      assert.equal(fake.launches(), count);
      writeFileSync(fake.script, originalBinary);
    });

    await t.test('supervisor loss closes the Job and retains the unknown lease across restart', async () => {
      const interrupted = intake('claude_code', 'grandchildren hang');
      interrupted.confirm();
      const descendants = await until(() => readDescendants(interrupted.copy), 20_000);
      assert.equal(descendants.length, 2);
      assert.equal(fake.stopSupervisor(), true);
      const first = await settle(interrupted);
      assert.equal(first.receipt.status, 'indeterminate');
      assert.equal(first.result && first.result.reasonCode, 'external-stop-unverified');
      assert.ok(first.events.every(({ reasonCode }) => reasonCode !== 'external-job-stopped'));
      assert.equal(existsSync(join(interrupted.copy, 'changed-files.json')), false);
      const gone = (pid: number) => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      };
      await until(async () => descendants.every(gone) || undefined, 5_000);
      const started = fake.launches();
      const lease = store.workItems.get(interrupted.workId)!.leaseId!;
      assert.ok(lease);
      await dispatcher.close();
      const reopened = new Dispatcher(store.workItems);
      new ExternalDelegations(store, reopened, sources, () => {}, { executor });
      try {
        await reopened.start();
        assert.equal(store.workItems.get(interrupted.workId)?.leaseId, lease);
        assert.equal(await reopened.resolve(interrupted.workId, lease, 'failed'), false);
        assert.equal(fake.launches(), started);
      } finally { await reopened.close(); }
    });
  } finally {
    await dispatcher.close();
    store.close();
    for (const [index, variable] of syntheticVariables.entries()) {
      if (saved[index] === undefined) delete process.env[variable];
      else process.env[variable] = saved[index];
    }
    rmSync(folder, { recursive: true, force: true });
  }
});
