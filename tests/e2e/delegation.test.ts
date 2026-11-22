import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ChatService } from '../../apps/adapter/src/http/chat.ts';
import type { Turn } from '../../apps/adapter/src/http/chat.ts';
import { delegateTool, listSpecialistsTool } from '../../apps/adapter/src/opencode/permissions.ts';
import { DelegationService } from '../../apps/adapter/src/runs/delegation.ts';
import { AttachmentService } from '../../apps/adapter/src/runs/attachments.ts';
import { DelegationHandoff } from '../../apps/adapter/src/runs/delegation-handoff.ts';
import { parseDelegationBudgets } from '../../apps/adapter/src/runs/delegation-ledger.ts';
import { Dispatcher } from '../../apps/adapter/src/runs/dispatcher.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';
import { dataDirectory } from './test-data.ts';

const alias = 'synthetic-delegation';
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
type Tool = { name: string; parameters: { properties: object; required: string[]; additionalProperties: boolean } };
type Request = Omit<WireRequest, 'tools'> & { tools?: { function: Tool }[] };
type ModelCall = { name: string; args: Record<string, unknown> };

test('attachment upload and handoff copy support a long specialist data root', () => {
  return (async () => {
    const root = mkdtempSync(join(dataDirectory(), 'long-path-'));
    const web = join(root, 'a'.repeat(112), 'web');
    const agentId = randomUUID();
    const id = randomUUID();
    const workspace = join(web, 'agents', agentId, 'sessions', id);
    mkdirSync(join(workspace, 'attachments'), { recursive: true });
    const store = new WebStore(join(root, 'web.sqlite'));
    try {
      store.createAgent(store.agentCreation(agentId, { name: 'Synthetic specialist' }, () => {}));
      store.createSession({ id, upstreamID: 'synthetic-long-path', createdAt: Date.now(), agent: 'inspector', alias },
        undefined, { agentId, workspaceID: agentId });
      const data = Buffer.from('Synthetic long-path attachment');
      const attachments = new AttachmentService(store);
      const uploaded = await attachments.upload(id, workspace, 'notes.txt', 'text/plain', data.length, async () => data);
      assert.ok(join(workspace, 'attachments', uploaded.id + '.source').length > 260);
      const [verified] = attachments.verifiedSelection(id, workspace, [uploaded.id]);
      const handoff = new DelegationHandoff(join(web, 'agents', agentId));
      const handoffId = randomUUID();
      const [file] = handoff.stage(handoffId, [{ ...verified, classification: 'unclassified' }]);
      assert.ok(join(web, 'agents', agentId, 'delegation-handoff', handoffId, file.fileId + '.source').length > 260);
      assert.equal(file.sha256, uploaded.sha256);
      assert.notEqual(file.identity.inode, verified.record.original.inode);
      assert.deepEqual(handoff.read(handoffId, file).data, data);
    } finally { store.close(); }
  })();
});

test('pinned OpenCode authorizes and admits specialist work through the SSE broker', { timeout: 120_000 }, async (context) => {
  const root = mkdtempSync(join(dataDirectory(), 'delegation-'));
  const profile = join(root, 'profile');
  const audit = join(root, 'launch');
  for (const path of [profile, audit, join(root, 'sessions'), join(root, 'model-work'), join(root, 'artifacts')]) mkdirSync(path);
  const file = join(root, 'web.sqlite');
  const store = new WebStore(file);
  const dispatcher = new Dispatcher(store.workItems);
  const delegations = new DelegationService(store, root, dispatcher);
  const scenarios = new Map<string, { steps: ModelCall[]; results: string[]; schemas?: Tool[] }>();
  let metadataLeak = false;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let chat: ChatService | undefined;
  try {
    for (const id of ['synthetic-a', 'synthetic-b', 'synthetic-archived']) {
      store.createAgent(store.agentCreation(id, { name: id, introduction: 'Synthetic introduction' }, () => {}));
    }
    store.updateAgent('synthetic-archived', 1, null, 'available');
    runtime = await startRuntime(audit, { url: 'http://example.invalid', key: randomUUID(), alias, isolatedJob: true,
      fetch: async (_target, init) => {
        if (!init?.body) return Response.json({ data: [{ id: alias }] });
        const wire = String(init.body);
        metadataLeak ||= /policy_nonce|_oep_transport_token|oep-ticket-[a-f0-9]{64}/.test(wire);
        const request = JSON.parse(wire) as Request;
        const user = request.messages.findLastIndex(({ role }) => role === 'user');
        const id = [...scenarios.keys()].find((marker) => JSON.stringify(request.messages[user]?.content).includes(marker));
        if (!id) return new Response(null, { status: 400 });
        const scenario = scenarios.get(id)!;
        scenario.schemas ??= request.tools?.map(({ function: tool }) => tool) ?? [];
        const results = request.messages.slice(user + 1).filter(({ role }) => role === 'tool');
        scenario.results = results.map(({ content }) => typeof content === 'string' ? content : JSON.stringify(content));
        const step = scenario.steps[results.length];
        if (!step) return completion(alias, [{ role: 'assistant', content: 'Synthetic verified reply' }], 'stop');
        return completion(alias, toolCall(0, 'call_synthetic_delegation_' + results.length, step.name, step.args), 'tool_calls');
      },
    }, profile);
    const service = chat = new ChatService(store, runtime, root, join(audit, 'web-turns.jsonl'), () => {}, store, dispatcher, delegations);
    await dispatcher.start();
    const main = await chat.create('inspector');
    const specialist = await chat.create('inspector', 'default', undefined, undefined,
      { agentId: 'synthetic-a', workspaceID: 'synthetic-a' });
    const contents = Buffer.from('Synthetic selected file for a specialist');
    const upload = (session: typeof main, name: string) => service.attachments.upload(session.id, service.workspace(session),
      name, 'text/plain', contents.length, async () => contents);
    const selected = await upload(main, 'selected.txt');
    const sameContents = await upload(main, 'duplicate.txt');
    const unselected = await upload(main, 'unselected.txt');
    const foreign = await upload(specialist, 'private.txt');
    using db = new DatabaseSync(file);
    db.prepare("INSERT INTO file_classifications VALUES ('attachment',?,'legacy-default',?,'confidential',1)")
      .run(selected.id, selected.sha256);
    const request = (requestKey: string, specialistId = 'synthetic-a', task = 'Synthetic task', attachmentIds?: string[]): ModelCall =>
      ({ name: delegateTool, args: { specialistId, task, requestKey, attachmentIds } });
    const run = async (marker: string, steps: ModelCall[], attachments: string[] = [], session = main,
      expected = 'verified') => {
      const input: Turn = { id: randomUUID(), text: marker, attachments, workbook: false };
      const scenario = { steps, results: [] } as NonNullable<ReturnType<typeof scenarios.get>>;
      scenarios.set(marker, scenario);
      await service.submit(session, input);
      const state = await until(() => {
        const { state } = store.get(input.id);
        return Promise.resolve(['verified', 'failed', 'cancelled', 'indeterminate'].includes(state) ? state : undefined);
      }, 35_000);
      assert.equal(state, expected);
      return { ...scenario, input };
    };
    const allowed = await run('Synthetic admission workflow', [
      { name: listSpecialistsTool, args: {} },
      request('key-a', 'synthetic-a', 'Synthetic content', [selected.id]),
      request('key-a', 'synthetic-a', 'Synthetic content', [selected.id]),
      request('key-a', 'synthetic-a', 'Synthetic changed content', [selected.id]),
      request('key-a-alias', 'synthetic-a', 'Synthetic content', [sameContents.id]),
      request('key-a-alias', 'synthetic-a', 'Synthetic changed content', [selected.id]),
      request('key-main', 'main'),
      request('key-archived', 'synthetic-archived'),
      request('key-unselected', 'synthetic-a', 'Synthetic missing selection', [unselected.id]),
      request('key-foreign', 'synthetic-a', 'Synthetic missing selection', [foreign.id]),
      request('key-b', 'synthetic-b'),
      request('key-third'),
      request('key-fourth', 'bi'),
      { name: listSpecialistsTool, args: {} },
    ], [selected.id, sameContents.id]);
    assert.equal(allowed.results.length, 14);
    const advertised = allowed.schemas?.filter(({ name }) => name === listSpecialistsTool || name === delegateTool);
    assert.equal(advertised?.length, 2);
    assert.deepEqual(advertised?.find(({ name }) => name === listSpecialistsTool)?.parameters,
      { type: 'object', properties: {}, required: [], additionalProperties: false });
    const delegateSchema = advertised?.find(({ name }) => name === delegateTool)?.parameters;
    assert.equal(delegateSchema?.additionalProperties, false);
    assert.deepEqual(delegateSchema?.required, ['specialistId', 'task', 'requestKey']);
    assert.deepEqual(Object.keys(delegateSchema!.properties).sort(), ['attachmentIds', 'requestKey', 'specialistId', 'task']);
    const listing = JSON.parse(allowed.results[0]) as { id: string; status: string }[];
    assert.ok(listing.every((item) => Object.keys(item).sort().join(',') === 'id,introduction,name,status'));
    assert.ok(listing.some(({ id, status }) => id === 'synthetic-archived' && status === 'paused'));
    const first = JSON.parse(allowed.results[1]) as { delegationId: string; status: string; noticeCode: string };
    assert.equal(first.status, 'queued');
    assert.equal(first.noticeCode, 'DELEGATION_ACCEPTED');
    for (const index of [2, 4]) assert.deepEqual(JSON.parse(allowed.results[index]), first);
    for (const index of [3, 5]) assert.deepEqual(JSON.parse(allowed.results[index]), { errorCode: 'DELEGATION_KEY_CONFLICT' });
    for (const index of [6, 7]) assert.deepEqual(JSON.parse(allowed.results[index]), { errorCode: 'DELEGATION_TARGET_UNAVAILABLE' });
    for (const index of [8, 9]) assert.deepEqual(JSON.parse(allowed.results[index]), { errorCode: 'DELEGATION_ATTACHMENT_UNAVAILABLE' });
    for (const index of [10, 11]) assert.equal(JSON.parse(allowed.results[index]).status, 'queued');
    assert.deepEqual(JSON.parse(allowed.results[12]), { errorCode: 'DELEGATION_BUDGET_EXCEEDED' });
    assert.ok(JSON.parse(allowed.results[13]).some(({ id, status }: { id: string; status: string }) => id === 'synthetic-b' && status === 'queued'));
    assert.deepEqual(db.prepare('SELECT target_agent_id FROM delegations ORDER BY rowid').all().map(({ target_agent_id }) => target_agent_id),
      ['synthetic-a', 'synthetic-b', 'synthetic-a']);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM delegation_request_keys').get()?.total, 4);
    const delegation = delegations.ledger.get(first.delegationId)!;
    assert.equal(delegation.parentRunId, allowed.input.id);
    assert.equal(delegation.parentSessionId, main.id);
    assert.deepEqual([delegation.reservedRequests, delegation.reservedTools, delegation.reservedMs], [10, 30, 300_000]);
    const work = dispatcher.items.get(delegation.workId)!;
    assert.equal(work.source, 'delegation');
    assert.equal(work.expiresAt! - work.enqueuedAt, 600_000);
    const manifest = delegations.ledger.files(delegation.id, 'inbound');
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].sourceId, selected.id);
    assert.equal(manifest[0].classification, 'confidential');
    assert.equal(manifest[0].sha256, hash(contents));
    assert.notEqual(manifest[0].fileId, selected.id);
    assert.notEqual(manifest[0].identity.inode, store.attachment(main.id, selected.id)?.original.inode);
    assert.deepEqual(delegations.handoff.read(delegation.id, manifest[0]).data, contents);
    assert.throws(() => delegations.handoff.read(delegation.id, { ...manifest[0], sha256: '0'.repeat(64) }));
    assert.throws(() => delegations.handoff.read(delegation.id, { ...manifest[0], fileId: '../private' }));
    assert.throws(() => delegations.handoff.read(JSON.parse(allowed.results[10]).delegationId, manifest[0]));
    const snapshot = delegations.ledger.inspect(delegation.id)!;
    assert.deepEqual(snapshot.events.map(({ state }) => state), ['queued', 'deduplicated', 'deduplicated']);
    assert.ok(!JSON.stringify(snapshot.events).includes('Synthetic'));
    const strayId = randomUUID();
    const stray = join(root, 'delegation-handoff', strayId);
    mkdirSync(stray);
    writeFileSync(join(stray, randomUUID() + '.source'), contents);
    const afterRestart = new DelegationService(store, root, dispatcher);
    assert.throws(() => readFileSync(stray), { code: 'ENOENT' });
    assert.deepEqual(afterRestart.handoff.read(delegation.id, manifest[0]).data, contents);

    const denial = await run('Synthetic specialist forbidden', [request('specialist')], [], specialist, 'failed');
    assert.ok(denial.schemas?.every(({ name }) => name !== delegateTool && name !== listSpecialistsTool));
    assert.deepEqual(denial.results, []);
    const forgery = await run('Synthetic extra parent field', [{ name: delegateTool, args: {
      ...request('forged').args, parentRunId: allowed.input.id,
    } }], [], main, 'failed');
    assert.deepEqual(forgery.results, []);
    assert.deepEqual(delegations.invoke(delegateTool, request('forged').args, {
      store, session: specialist, input: allowed.input, attachments: service.attachments,
      workspace: () => { throw new Error('Forbidden parent cannot reach workspace'); },
    }, new AbortController().signal), { errorCode: 'DELEGATION_FORBIDDEN' });
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM delegations').get()?.total, 3);

    const budgets = parseDelegationBudgets({ ...delegations.ledger.budgets(),
      delegationsPerMessage: 1, modelRequestsPerDelegation: 2, queueMs: 240_000 });
    assert.ok(budgets);
    delegations.ledger.saveBudgets(budgets);
    const adjusted = await run('Synthetic adjusted reservation', [request('adjusted'), request('denied', 'synthetic-b')]);
    assert.deepEqual(JSON.parse(adjusted.results[1]), { errorCode: 'DELEGATION_BUDGET_EXCEEDED' });
    const adjustedRow = delegations.ledger.get(JSON.parse(adjusted.results[0]).delegationId)!;
    const adjustedWork = dispatcher.items.get(adjustedRow.workId)!;
    assert.equal(adjustedRow.reservedRequests, 2);
    assert.equal(adjustedWork.expiresAt! - adjustedWork.enqueuedAt, 240_000);
    store.saveTurnLimits({ ...store.turnLimits(), toolCalls: 2 });
    const counted = await run('Synthetic replay reaches tool cap',
      [request('tool-cap-a'), request('tool-cap-b'), request('tool-cap-c')], [], main, 'cancelled');
    assert.equal(counted.results.length, 2);
    assert.deepEqual(JSON.parse(counted.results[0]), JSON.parse(counted.results[1]));
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM delegation_request_keys WHERE parent_run_id=?').get(counted.input.id)?.total, 2);
    assert.equal(metadataLeak, false);
  } finally {
    try { await dispatcher.close(); await chat?.close(); }
    finally {
      store.close();
      if (runtime) {
        const stopped = await runtime.stop();
        assert.deepEqual([stopped.supervisorExit, stopped.childExit, stopped.orphans], [0, 0, 0]);
        context.diagnostic(`OpenCode ${runtime.version}, supervisorExit=${stopped.supervisorExit}, childExit=${stopped.childExit}, orphans=${stopped.orphans}`);
      }
    }
  }
});
