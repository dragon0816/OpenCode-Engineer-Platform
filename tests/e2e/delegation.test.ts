import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ChatService } from '../../apps/adapter/src/http/chat.ts';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import type { Turn } from '../../apps/adapter/src/http/chat.ts';
import { delegateTool, listSpecialistsTool, readFileTool, statusTool, writeFileTool } from '../../apps/adapter/src/opencode/permissions.ts';
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
import { webAPI } from './web-api.ts';

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

test('the paired Web adapter delivers specialist runs, cancellations, caps, and BI receipts', { timeout: 120_000 }, async (context) => {
  const root = mkdtempSync(join(dataDirectory(), 'delegate-life-'));
  const profile = join(root, 'profile');
  const audit = join(root, 'launch');
  mkdirSync(profile);
  mkdirSync(audit);
  const specialist = randomUUID();
  const second = randomUUID();
  const otherModel = 'synthetic-specialist';
  const models = [alias, otherModel];
  let attachmentId: string;
  let foreignId: string;
  const source = 'Synthetic evidence establishes amber.';
  const output = 'Synthetic explicit export';
  const release = Promise.withResolvers<void>();
  const waiting = new Set<string>();
  const requests: { task: string; model: string; tools: string[] }[] = [];
  const readResults: string[] = [];
  const batch: Record<string, { target: string; task: string }[]> = {
    concurrent: [{ target: specialist, task: 'first' }, { target: second, task: 'second' }, { target: specialist, task: 'queued' }],
    cancel: [{ target: second, task: 'cancel' }], model: [{ target: second, task: 'model' }],
    tool: [{ target: second, task: 'tool' }], time: [{ target: second, task: 'time' }],
    review: [{ target: 'bi', task: 'review' }], incomplete: [{ target: 'bi', task: 'incomplete' }],
  };
  const runtime = await startRuntime(audit, { url: 'http://example.invalid', key: randomUUID(), alias, aliases: models, isolatedJob: true,
    fetch: async (_target, init) => {
      if (!init?.body) return Response.json({ data: models.map((id) => ({ id })) });
      const request = JSON.parse(String(init.body)) as Request & { stream?: boolean; model: string };
      if (!request.stream) {
        if (!JSON.stringify(request.messages).includes(source)) {
          return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Synthetic health reply' } }] });
        }
        requests.push({ task: 'BI', model: request.model, tools: request.tools?.map(({ function: fn }) => fn.name) ?? [] });
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          title: 'Synthetic candidate', action: 'publish', fields: { setting: { quote: 'amber', value: 'amber' } },
        }) } }] });
      }
      const user = request.messages.findLastIndex(({ role }) => role === 'user');
      const text = JSON.stringify(request.messages[user]?.content);
      const results = request.messages.slice(user + 1).filter(({ role }) => role === 'tool');
      const task = /Main fixture (\w+)/.exec(text)?.[1];
      const reply = () => completion(request.model, [{ role: 'assistant', content: 'Synthetic verified reply' }], 'stop');
      const tool = (name: string, args: Record<string, unknown>) =>
        completion(request.model, toolCall(0, `call_synthetic_${results.length}`, name, args), 'tool_calls');
      if (task) {
        const next = batch[task][results.length];
        if (!next) return reply();
        return tool(delegateTool, { specialistId: next.target, task: `Child fixture ${next.task}`, requestKey: next.task,
          ...(next.task === 'review' && { attachmentIds: [attachmentId] }) });
      }
      const child = /Child fixture (\w+)/.exec(text)?.[1];
      if (!child) return new Response(null, { status: 400 });
      requests.push({ task: child, model: request.model, tools: request.tools?.map(({ function: fn }) => fn.name) ?? [] });
      if (!results.length && child === 'first') { waiting.add(child); await release.promise; }
      if (child === 'cancel' || child === 'time') {
        waiting.add(child);
        await new Promise<void>((resolve) => {
          if (init.signal?.aborted) resolve();
          else init.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return reply();
      }
      if (child === 'first' && results.length === 0) return tool(readFileTool, { attachment: foreignId });
      if (child === 'first' && results.length === 1) {
        readResults.push(JSON.stringify(results[0].content));
        return tool(writeFileTool, { name: 'report.txt', content: output });
      }
      if (child === 'model' && !results.length || child === 'tool' && results.length < 2) return tool(statusTool, {});
      return reply();
    },
  }, profile);
  let web: Awaited<ReturnType<typeof startAdapter>> | undefined;
  try {
    const store = new WebStore(join(root, 'web.sqlite'));
    try {
      store.createAgent(store.agentCreation(specialist, { name: 'First specialist', defaultModel: otherModel }, () => {}));
      store.createAgent(store.agentCreation(second, { name: 'Second specialist', defaultModel: alias }, () => {}));
      store.updateAgent('bi', 1, { defaultModel: otherModel }, 'available');
    } finally { store.close(); }
    web = await startAdapter(root, runtime, () => undefined);
    const api = await webAPI(web.pairURL());
    const json = async (response: Response, status = 200) => {
      assert.equal(response.status, status);
      return response.json();
    };
    const session = await json(await api.post('/api/sessions', { agent: 'inspector' }), 201);
    const sessionPath = `/api/sessions/${session.id}`;
    ({ id: attachmentId } = await json(await api.upload(sessionPath + '/attachments', 'source.txt', source), 201));
    const foreign = await json(await api.post('/api/sessions', { agent: 'inspector' }), 201);
    ({ id: foreignId } = await json(await api.upload(`/api/sessions/${foreign.id}/attachments`, 'private.txt', 'Synthetic private bytes'), 201));
    using db = new DatabaseSync(join(root, 'web.sqlite'));
    const detail = async (id: string) => json(await api.get(`/api/delegations/${id}`));
    const cancel = async (id: string) => json(await api.post(`/api/delegations/${id}/cancel`, {}));
    const submit = async (scenario: string, attachments: string[] = []) => {
      const runId = randomUUID();
      await json(await api.post(sessionPath + '/turns', { id: runId, text: 'Main fixture ' + scenario, attachments, workbook: false }), 202);
      return until(async () => {
        const state = await json(await api.get(sessionPath + '/state'));
        if (state.runs.at(-1)?.state !== 'verified') return;
        const records = db.prepare('SELECT id FROM delegations WHERE parent_run_id=? ORDER BY rowid').all(runId).map(({ id }) => String(id));
        if (records.length === batch[scenario].length) return records;
      }, 20_000);
    };
    const result = (id: string) => until(async () => (await detail(id)).result ?? undefined, 25_000);
    const [first, other, queued] = await submit('concurrent');
    await until(async () => waiting.has('first') && (await detail(other)).receipt.status === 'running' || undefined, 15_000);
    assert.equal(requests.some(({ task }) => task === 'second'), false);
    assert.equal((await detail(queued)).receipt.status, 'queued');
    assert.equal((await fetch(api.origin + '/api/delegations/' + first)).status, 401);
    assert.equal((await cancel(queued)).result.status, 'cancelled');
    release.resolve();
    const all = await Promise.all([result(first), result(other)]);
    assert.ok(all.every(({ status }) => status === 'succeeded'));
    const a = await detail(first);
    const b = await detail(other);
    assert.notEqual(a.childRunId, b.childRunId);
    assert.notEqual(a.childSessionId, b.childSessionId);
    assert.equal(db.prepare('SELECT origin FROM session_ownership WHERE session_id=?').get(a.childSessionId)?.origin, 'delegation');
    assert.deepEqual(requests.map(({ task, model }) => [task, model]),
      [['first', otherModel], ['first', otherModel], ['first', otherModel], ['second', alias]]);
    assert.ok(requests.every(({ tools }) => !tools.includes(delegateTool) && !tools.includes(listSpecialistsTool)));
    assert.match(readResults[0], /Tool authorization unavailable/);
    assert.doesNotMatch(readResults[0], /Synthetic private bytes/);
    const [file] = all[0].files;
    assert.deepEqual({ ...file, fileId: undefined }, { fileId: undefined, name: 'report.txt', bytes: Buffer.byteLength(output),
      sha256: hash(Buffer.from(output)), mime: 'text/plain' });
    const downloaded = await api.get(`/api/delegations/${first}/files/${file.fileId}`);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('x-oep-sha256'), file.sha256);
    assert.equal(await downloaded.text(), output);
    assert.equal((await api.get(`/api/delegations/${other}/files/${file.fileId}`)).status, 404);
    assert.deepEqual((await cancel(first)).result, all[0]);
    const [running] = await submit('cancel');
    await until(() => Promise.resolve(waiting.has('cancel') || undefined), 15_000);
    assert.equal((await cancel(running)).result.status, 'cancelled');
    const path = '/api/settings/delegation-budgets';
    const { values } = await json(await api.get(path));
    const budget = async (patch: object) => json(await api.post(path, { ...values, ...patch }));
    await json(await api.post(path, { ...values, toolCallsPerDelegation: 0 }), 400);
    await budget({ modelRequestsPerDelegation: 1 });
    const [modelCap] = await submit('model');
    assert.equal((await result(modelCap)).reasonCode, 'child-model-cap');
    assert.equal(db.prepare('SELECT used_requests FROM delegations WHERE id=?').get(modelCap)?.used_requests, 1);
    await budget({ toolCallsPerDelegation: 1 });
    const [toolCap] = await submit('tool');
    assert.equal((await result(toolCap)).reasonCode, 'child-tool-or-turn-limit');
    assert.equal(db.prepare('SELECT used_tools FROM delegations WHERE id=?').get(toolCap)?.used_tools, 1);
    await budget({ executionMsPerDelegation: 4000 });
    const [timeCap] = await submit('time');
    assert.equal((await result(timeCap)).status, 'timed_out');
    await budget({});

    const knowledge = runtime.knowledge!.reviewStore;
    const schema = knowledge.installReviewSchema('delegation-target', 'delegation-target', '1', ['setting']);
    knowledge.stage('delegation-seed', {
      vault: { id: 'delegation-target', kind: 'bi', title: 'Synthetic target' }, schema: schema.sha256,
      sources: [{ id: 'seed', ref: 'seed.md', original: source, markdown: source }],
      cards: [{ id: 'seed', key: 'seed', type: 'record', title: 'Seed', version: '1', fields: { setting: 'amber' } }],
      relationships: [], evidence: [{ sourceId: 'seed', cardId: 'seed', field: 'setting', start: 0, end: source.length }],
    });
    knowledge.decideReview('delegation-seed', 0, 'approved');
    knowledge.publishReview('delegation-seed');
    await json(await api.post('/api/jobs', { action: 'configure', domain: 'synthetic', origins: [], target: 'delegation-target' }));
    const [review] = await submit('review', [attachmentId]);
    const pending = await result(review);
    assert.equal(pending.summary, '已送審');
    assert.equal(knowledge.reviews().find(({ id }) => id === pending.reviewRef.reviewId)?.status, 'pending');
    assert.throws(() => knowledge.publishReview(pending.reviewRef.reviewId));
    assert.equal(knowledge.reviewBase('delegation-target').cards.length, 1);
    assert.deepEqual(requests.filter(({ task }) => task === 'BI'), [{ task: 'BI', model: otherModel, tools: [] }]);
    const [incomplete] = await submit('incomplete');
    assert.equal((await result(incomplete)).status, 'needs_input');
    for (const id of [first, other, queued, running, modelCap, toolCap, timeCap, review, incomplete]) {
      assert.equal(db.prepare("SELECT state FROM delegation_notices WHERE delegation_id=? AND kind='completion'").get(id)?.state, 'pending');
    }
    await web.close();
    web = undefined;
    const unknown = randomUUID();
    const expired = randomUUID();
    const unknownSession = randomUUID();
    const unknownRun = randomUUID();
    const seed = new WebStore(join(root, 'web.sqlite'));
    try {
      const parent = db.prepare('SELECT parent_session_id,parent_run_id FROM delegations WHERE id=?').get(review)!;
      const ref = { store: 'web' as const, sessionId: String(parent.parent_session_id), runId: String(parent.parent_run_id) };
      const input = (specialistId: string) => ({ specialistId, task: 'Child fixture forged-resend', requestKey: 'restart' });
      seed.delegations.atomic(() => seed.delegations.admit(unknown, unknownRun, ref, input(specialist), '1'.repeat(64), []));
      const lease = seed.workItems.claim((candidate) => candidate.sourceKey === unknown)!;
      assert.equal(seed.workItems.markStarted(lease), true);
      seed.delegations.claim(lease);
      seed.createSession({ id: unknownSession, upstreamID: 'unverifiable-upstream', agent: 'inspector', alias: otherModel,
        createdAt: Date.now() }, undefined, { agentId: specialist, workspaceID: specialist, origin: 'delegation' });
      seed.saveTurn(unknownSession, { id: unknownRun, mode: 'web-chat', state: 'accepted', createdAt: Date.now(), workspace: root,
        alias: otherModel, sessionID: 'unverifiable-upstream', submissionID: 'unverifiable-submission', retries: 0, errors: [] },
      '2'.repeat(64), undefined, undefined, unknown);
      seed.change(unknownRun, 'running');
      const expiryRef = { ...ref, runId: String(db.prepare('SELECT parent_run_id FROM delegations WHERE id=?').get(incomplete)?.parent_run_id) };
      seed.delegations.atomic(() => seed.delegations.admit(expired, randomUUID(), expiryRef, input(second), '3'.repeat(64), []));
      db.prepare('UPDATE agent_work_items SET expires_at=enqueued_at WHERE source_key=?').run(expired);
    } finally { seed.close(); }
    const countBeforeRestart = requests.length;
    web = await startAdapter(root, runtime, () => undefined);
    const restarted = await webAPI(web.pairURL());
    assert.equal((await json(await restarted.get(`/api/delegations/${unknown}`))).result.status, 'indeterminate');
    const dropped = await until(async () => (await json(await restarted.get(`/api/delegations/${expired}`))).result ?? undefined, 5000);
    assert.equal(dropped.status, 'timed_out');
    assert.equal(dropped.reasonCode, 'queue-expired');
    assert.equal(requests.length, countBeforeRestart);
    assert.ok(db.prepare('SELECT lease_id FROM agent_work_items WHERE source_key=?').get(unknown)?.lease_id);
  } finally {
    release.resolve();
    try { await web?.close(); }
    finally {
      const stopped = await runtime.stop();
      assert.deepEqual([stopped.supervisorExit, stopped.childExit, stopped.orphans], [0, 0, 0]);
      context.diagnostic(`OpenCode ${runtime.version}, supervisorExit=${stopped.supervisorExit}, childExit=${stopped.childExit}, orphans=${stopped.orphans}`);
    }
  }
});
