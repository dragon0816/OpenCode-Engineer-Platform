import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { customMcpName } from '../../apps/adapter/src/runs/custom-mcp.ts';
import { readMcpFingerprint } from '../../apps/adapter/src/runs/mcp-trust.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';
import { syntheticRepository } from '../fixtures/knowledge/repository.ts';
import { dataDirectory } from './test-data.ts';
import { completion, toolCall, type WireRequest } from './synthetic-completion.ts';
import { webAPI } from './web-api.ts';

const json = async (response: Response, status = 200) => {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
};
const skillName = 'synthetic-calibration-skill';
const skillBody = 'Use the SABLE-4821 calibration procedure.';
const encode = (text: string) => new TextEncoder().encode(text);
const sample = (name: string, description = 'A synthetic calibration procedure.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${skillBody}\n`;
const common = { url: 'http://example.invalid/v1', alias: 'synthetic-capabilities', isolatedJob: true };
const checkedGateway = (run: typeof fetch): typeof fetch => async (target, init) => {
  if (String(target).endsWith('/models')) return Response.json({ data: [{ id: common.alias }] });
  if (String(init?.body).includes('Reply with exactly OEP-READY.')) {
    return Response.json({ choices: [{ message: { content: 'OEP-READY' }, finish_reason: 'stop' }] });
  }
  try { return await run(target, init); }
  catch (error) {
    console.error('Synthetic capability request failed:', (error as Error).message);
    throw error;
  }
};

async function session(api: Awaited<ReturnType<typeof webAPI>>, route = '/api/sessions') {
  const { id } = await json(await api.post(route, { agent: 'inspector' }), 201);
  return route + '/' + id;
}

async function turn(api: Awaited<ReturnType<typeof webAPI>>, route: string, text: string, answer: string) {
  await json(await api.post(route + '/turns', { id: randomUUID(), text, attachments: [], workbook: false }), 202);
  const state = await until(async () => {
    const result = await json(await api.get(route + '/state'));
    return ['verified', 'failed', 'indeterminate', 'cancelled'].includes(result.runs.at(-1)?.state) ? result : undefined;
  }, 38_000);
  assert.equal(state.runs.at(-1).state, 'verified', JSON.stringify(state.runs.at(-1)));
  assert.ok(state.messages.some(({ text }: { text: string }) => text?.includes(answer)), JSON.stringify(state.messages));
}

test('imports Skills and AEP Workflows, loads only enabled Skill text, and binds and asks a published Knowledge import', { timeout: 160_000 }, async () => {
  const root = mkdtempSync(join(dataDirectory(), 'library-'));
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const { snapshot } = goldFixture();
  const { id: vault } = snapshot.vault;
  const passage = snapshot.passages.find(({ text }) => text.includes('±0.8 dB'))!;
  assert.ok(passage);
  const question = 'SYN-48B 零點校正容差是多少？';
  let seenSkill = false;
  const synthetic: typeof fetch = async (_target, init) => {
    const { model, messages, tools, stream } = JSON.parse(String(init?.body)) as WireRequest & { stream: boolean };
    const user = JSON.stringify(messages.findLast(({ role }) => role === 'user')?.content);
    if (!stream) {
      const input = JSON.parse(String(messages.find(({ role }) => role === 'user')?.content));
      assert.equal(input.question, question);
      const evidence = input.evidence.find(({ text }: { text: string }) => text.includes('±0.8 dB'));
      assert.ok(evidence);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ state: 'answer',
        citations: [{ passageID: evidence.id, quote: '±0.8 dB' }] }) }, finish_reason: 'stop' }] });
    }
    const skill = tools?.find(({ function: fn }) => fn?.name === 'skill');
    const instructions = JSON.stringify(messages.filter(({ role }) => role === 'system'));
    const latest = messages.at(-1);
    if (user.includes('SYNTHETIC-SKILL-LOAD')) {
      if (latest?.role !== 'tool') {
        assert.ok(skill, 'The native skill tool is offered');
        assert.match(instructions, new RegExp(skillName));
        assert.doesNotMatch(instructions, /SABLE-4821/);
        return completion(model, toolCall(0, 'call_skill_library', 'skill', { id: skillName }), 'tool_calls');
      }
      if (!JSON.stringify(latest.content).includes('SYNTHETIC-RESOURCE-582')) {
        assert.match(JSON.stringify(latest.content), /SABLE-4821/);
        return completion(model, toolCall(0, 'call_skill_resource', 'oep_file_read', { skill: skillName, resource: 'references/procedure.md' }), 'tool_calls');
      }
      seenSkill = true;
      return completion(model, [{ role: 'assistant', content: 'Synthetic Skill verified' }], 'stop');
    }
    assert.doesNotMatch(instructions, new RegExp(skillName));
    return completion(model, [{ role: 'assistant', content: 'Synthetic Skill unavailable' }], 'stop');
  };
  const runtime = await startRuntime(root, { ...common, key: randomUUID(), fetch: checkedGateway(synthetic) }, profile);
  try {
    const app = await startAdapter(root, runtime, () => {});
    try {
      const api = await webAPI(app.pairURL());
      const cap = '/api/capabilities/';
      const initial = await json(await api.get(cap + 'skills'));
      assert.ok(initial.skills.some(({ name, enabledFor }: { name: string; enabledFor: string[] }) =>
        name === 'hermes-test-driven-development' && enabledFor.includes('main')));
      assert.deepEqual(initial.skills.find(({ name }: { name: string }) => name === 'hermes-computer-use').enabledFor, []);
      const route = await session(api);
      const folder = join(root, 'calibration');
      mkdirSync(folder);
      writeFileSync(join(folder, 'SKILL.md'), sample(skillName));
      mkdirSync(join(folder, 'references'));
      writeFileSync(join(folder, 'references', 'procedure.md'), 'SYNTHETIC-RESOURCE-582');
      const imported = await json(await api.post(cap + 'skills/folder', { folder }));
      assert.deepEqual(imported.skills.find(({ name }: { name: string }) => name === skillName).enabledFor, []);
      const zipped = zipSync({ 'sample/': new Uint8Array(), 'sample/SKILL.md': encode(sample('synthetic-zipped')) });
      assert.ok((await json(await api.bytes(cap + 'skills/zip', 'sample.zip', zipped))).skills.some(({ name }: { name: string }) => name === 'synthetic-zipped'));
      const malformed = zipSync({ 'SKILL.md': encode(sample('synthetic-invalid', 'a'.repeat(1025))) });
      assert.equal((await json(await api.bytes(cap + 'skills/zip', 'invalid.zip', malformed), 400)).errorDetail.code, 'skill-frontmatter-invalid');
      await json(await api.post(cap + 'skills/enable', { name: skillName, assistant: 'main', enabled: true }));
      await turn(api, route, 'SYNTHETIC-SKILL-LOAD', 'Synthetic Skill verified');
      assert.equal(seenSkill, true);
      await json(await api.post(cap + 'skills/remove', { name: skillName }));
      await turn(api, await session(api), 'SYNTHETIC-SKILL-REMOVED', 'Synthetic Skill unavailable');
      const workflow = { metadata: { identity: { namespace: 'synthetic', name: 'inventory', version: '1.0.0' } },
        description: 'Read inventory.', parameters: [{ name: 'unit', type: 'text' }],
        steps: [{ capability: 'synthetic/inventory@1.0.0', inputs: { unit: { source: 'run', path: ['unit'] } } }] };
      assert.deepEqual(await json(await api.bytes(cap + 'workflows/import', 'inventory.json', encode(JSON.stringify(workflow)))),
        [{ id: 'synthetic/inventory@1.0.0', description: workflow.description, parameters: workflow.parameters, steps: workflow.steps }]);
      assert.equal((await json(await api.get(cap + 'workflows'))).length, 1);
      const packages = await json(await api.bytes(cap + 'knowledge/package-model', 'published.json', encode(JSON.stringify(snapshot))));
      assert.deepEqual(packages.map(({ id, source }: { id: string; source: string }) => [id, source]), [[vault, 'published.json']]);
      const assistant = await json(await api.get('/api/agents/main'));
      await json(await api.post('/api/agents/main', { action: 'edit', knowledgeReads: [vault], revision: assistant.agent.revision }));
      const answer = await json(await api.post(route + '/knowledge-ask', { vault, question }));
      assert.equal(answer.state, 'verified');
      assert.match(JSON.stringify(answer), /±0\.8 dB/);
      assert.deepEqual(await json(await api.post(cap + 'knowledge/remove', { id: vault, revision: snapshot.publication.revision })), []);
      assert.equal((await json(await api.post(route + '/knowledge-ask', { vault, question }))).reason, 'vault-unavailable');
      const repository = join(root, 'BI published export');
      syntheticRepository(repository, { snapshot: { ...snapshot, vault: { ...snapshot.vault, id: 'synthetic-bi-repository' } } });
      const repos = await json(await api.post(cap + 'knowledge/repository', { folder: repository, allowModel: true }));
      assert.deepEqual(repos.map(({ id, source }: { id: string; source: string }) => [id, source]), [['synthetic-bi-repository', 'BI published export']]);
    } finally { await app.close(); }
  } finally { await runtime.stop(); }
});

test('trusts a stdio executable, grants only one workspace, preserves network, and revokes after a fingerprint change', { timeout: 160_000 }, async () => {
  const root = mkdtempSync(join(dataDirectory(), 'trusted-mcp-'));
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const executable = join(root, 'Synthetic Instrument 1.exe');
  copyFileSync(process.execPath, executable);
  const actual = readMcpFingerprint(executable);
  assert.equal(actual.sha256, createHash('sha256').update(readFileSync(executable)).digest('hex'));
  const initial = { ...actual, signer: 'CN=Synthetic Device', thumbprint: 'a'.repeat(40), signatureStatus: 'Valid' };
  let fingerprint = initial;
  let toolName = '';
  const instrument = createServer((_request, response) => response.end('synthetic device over TCP'));
  await new Promise<void>((resolve, reject) => instrument.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = instrument.address();
  assert.ok(address && typeof address === 'object');
  const script = join(root, 'instrument.mjs');
  writeFileSync(script, `import { createInterface } from 'node:readline';
if (!process.argv.includes('--transport') || !process.argv.includes('stdio')) process.exit(2);
for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Synthetic Device', version: '1' } };
  if (method === 'tools/list') result = { tools: [{ name: 'device_read', description: 'Read a synthetic instrument', inputSchema: { type: 'object', additionalProperties: false, properties: {} } }] };
  if (method === 'tools/call') result = await (await fetch('http://127.0.0.1:${address.port}/')).text();
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
`);
  const synthetic: typeof fetch = async (_target, init) => {
    const { model, messages, tools } = JSON.parse(String(init?.body)) as WireRequest;
    const latest = messages.at(-1);
    const user = JSON.stringify(messages.findLast(({ role }) => role === 'user')?.content);
    const expected = user.includes('synthetic MCP allowed');
    assert.equal(tools?.some(({ function: fn }) => fn?.name === toolName) ?? false, expected);
    if (!expected) return completion(model, [{ role: 'assistant', content: 'Synthetic MCP unavailable' }], 'stop');
    if (latest?.role !== 'tool') return completion(model, toolCall(0, 'call_device_read', toolName, {}), 'tool_calls');
    assert.match(JSON.stringify(latest.content), /synthetic device over TCP/);
    return completion(model, [{ role: 'assistant', content: 'Synthetic MCP verified' }], 'stop');
  };
  const settings = { ...common, key: randomUUID(), fetch: checkedGateway(synthetic), mcpFingerprint: () => fingerprint };
  let runtime = await startRuntime(root, settings, profile);
  let app: Awaited<ReturnType<typeof startAdapter>> | undefined;
  const endpoint = '/api/settings/mcp/custom';
  try {
    app = await startAdapter(root, runtime, () => {});
    let api = await webAPI(app.pairURL());
    const created = await json(await api.post(endpoint, { action: 'create', transport: 'stdio', name: 'Synthetic Device',
      command: [executable, script, '--transport', 'stdio'], cwd: root, enabled: true, appliesToProjects: ['default', 'secondary'],
      environment: [], dataScope: '', timeouts: { startup: 10000, execution: 10000, catalog: 10000 } }));
    const id = created.changedId;
    toolName = customMcpName(id) + '_device_read';
    assert.equal(created.servers[0].status, 'paused');
    assert.equal((await json(await api.post(endpoint, { action: 'grant', id, workspace: 'legacy-default', enabled: true }), 400)).errorDetail.code, 'agent-mcp-invalid');
    const probe = await json(await api.post('/api/settings/mcp/test', { id }));
    assert.equal(probe.tools[0].name, 'device_read');
    const trusted = await json(await api.post(endpoint, { action: 'trust', id, confirmed: true }));
    assert.deepEqual(trusted.servers[0].trust, initial);
    assert.ok(trusted.workspaces.every(({ servers }: { servers: string[] }) => !servers.includes(id)));
    await json(await api.post(endpoint, { action: 'grant', id, workspace: 'legacy-default', enabled: true }));
    await app.close();
    app = undefined;
    await runtime.stop();
    const ledger = new WebStore(join(root, 'web.sqlite'));
    const definitions = ledger.customMcpServers();
    ledger.close();
    runtime = await startRuntime(root, settings, profile, definitions);
    app = await startAdapter(root, runtime, () => {});
    api = await webAPI(app.pairURL());
    const welcome = await session(api);
    await turn(api, welcome, 'synthetic MCP allowed', 'Synthetic MCP verified');
    const secondary = await session(api, '/api/projects/secondary/sessions');
    await turn(api, secondary, 'synthetic MCP denied', 'Synthetic MCP unavailable');
    fingerprint = { ...initial, signer: 'CN=Synthetic Device Replacement', thumbprint: 'b'.repeat(40), sha256: 'c'.repeat(64) };
    utimesSync(executable, new Date(), new Date(Date.now() - 30_000));
    const changed = await json(await api.get(endpoint));
    assert.equal(changed.servers[0].enabled, false);
    assert.equal(changed.servers[0].trust.changed, true);
    await turn(api, welcome, 'synthetic MCP revoked', 'Synthetic MCP unavailable');
    const trustedAgain = await json(await api.post(endpoint, { action: 'trust', id, confirmed: true }));
    assert.deepEqual(trustedAgain.servers[0].trust, fingerprint);
    assert.deepEqual(trustedAgain.workspaces.filter(({ servers }: { servers: string[] }) => servers.includes(id))
      .map(({ id }: { id: string }) => id), ['legacy-default']);
  } finally {
    try { await app?.close(); }
    finally { await runtime.stop(); await new Promise<void>((resolve) => instrument.close(() => resolve())); }
  }
});
