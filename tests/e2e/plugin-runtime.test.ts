import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { sha256, verifyPackage } from '../../apps/adapter/src/plugins/package.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { recoverPythonJobs } from '../../apps/adapter/src/plugins/python.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { sampleID, samplePage, samplePlugin } from '../fixtures/plugins/package.ts';
import { dataDirectory } from './test-data.ts';

const worker = sampleID + '.worker';
const reviewType = sampleID + '.review';
const route = '/api/plugins/' + sampleID;
const sourceText = 'The synthetic reference frequency is 4.2 GHz.';
const grantHeader = (token: string) => ({ 'X-OEP-Plugin': token });

function runtimeStub(root: string, reviewStore: KnowledgeStore, propose: (prompt: string, input: unknown) => unknown) {
  return { root, version: '2.3.2', alias: 'synthetic-plugin', aliases: ['synthetic-plugin'], builtInAliases: ['synthetic-plugin'],
    aliasHealth: () => [], redact: (value: string) => value, knowledge: { reviewStore, propose },
    endpoint: { request: async () => new Response(null, { status: 503 }) } } as unknown as Runtime;
}

test('paired page routes scope worker jobs, sources, and owner publication to the owning plugin', { timeout: 150_000 }, async () => {
  const root = dataDirectory();
  const web = join(root, 'web');
  mkdirSync(web);
  const session = randomUUID();
  const references = join(root, 'references');
  mkdirSync(references);
  writeFileSync(join(references, 'reference.txt'), sourceText);
  {
    const store = new WebStore(join(web, 'web.sqlite'));
    try {
      store.createSession({ id: session, upstreamID: randomUUID(), agent: 'inspector', alias: 'synthetic-plugin', createdAt: 1 });
      store.addProjectFolder('default', references);
    } finally { store.close(); }
  }
  const knowledge = new KnowledgeStore(join(root, 'knowledge.sqlite'));
  const models: unknown[] = [];
  const runtime = runtimeStub(root, knowledge, async (prompt, input) => {
    models.push({ prompt, input });
    return { content: 'Synthetic model receipt' };
  });
  const app = await startAdapter(web, runtime, () => {}, false, undefined, undefined, undefined, undefined,
    { dataRoot: root, version: '0.8.0' });
  const network = createServer((connection) => connection.destroy());
  const previousKey = process.env.OEP_LITELLM_API_KEY;
  process.env.OEP_LITELLM_API_KEY = randomUUID();
  try {
    await new Promise<void>((resolve) => network.listen(0, '127.0.0.1', resolve));
    const privateFile = join(root, 'unselected.txt');
    const outside = join(root, 'outside.txt');
    writeFileSync(privateFile, 'Synthetic file outside the plugin');
    const address = network.address();
    assert.ok(address && typeof address !== 'string');
    async function pair() {
      const launch = new URL(app.pairURL());
      const origin = launch.origin;
      const paired = await fetch(origin + '/api/pair', { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: launch.hash.slice(6) }) });
      assert.equal(paired.status, 200);
      const cookie = paired.headers.get('set-cookie')!.split(';')[0];
      const { csrf } = await paired.json();
      return (path: string, options: { data?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {}) => {
        const post = options.data !== undefined || options.bytes !== undefined;
        return fetch(origin + path, {
          method: post ? 'POST' : 'GET',
          headers: { Cookie: cookie, Origin: origin, 'X-OEP-CSRF': csrf,
            ...(post ? { 'Content-Type': options.bytes ? 'application/octet-stream' : 'application/json' } : {}),
            ...options.headers },
          body: options.bytes ? Buffer.from(options.bytes) : post ? JSON.stringify(options.data) : undefined,
        });
      };
    }
    const request = await pair();
    const json = async (response: Response, want = 200) => {
      const value = await response.json();
      assert.equal(response.status, want, JSON.stringify(value));
      return value;
    };
    const install = async (archive: Buffer, want = 200) => {
      const { token } = await json(await request('/api/plugins/preview', { bytes: archive }));
      return json(await request('/api/plugins/install', { data: { token, consent: true } }), want);
    };
    const missing = await install(samplePlugin({ runtime: true, dependency: 'nonexistent_oep_synthetic_distribution' }), 422);
    assert.equal(missing.errorDetail.code, 'plugin-python-dependencies');
    const archive = samplePlugin({ runtime: true, timeoutMs: 5_000, dependency: 'openpyxl' });
    await install(archive);
    const otherId = 'oep.synthetic-other';
    const other = samplePlugin({ runtime: true, namespace: otherId });
    await install(other);
    const grant = async (plugin = sampleID, bytes = archive) => json(await request(
      `/api/plugins/${plugin}/pages/${plugin}.page/${verifyPackage(bytes).digest}`));
    const page = await grant();
    const otherPage = await grant(otherId, other);
    const call = (method: string, params = {}, token = page.token, path = route) =>
      request(path + '/runtime', { data: { method, params }, headers: grantHeader(token) });
    await json(await call('components.list', {}, otherPage.token), 403);
    await json(await call('components.list', {}, page.token, '/api/plugins/' + otherId), 403);
    const secondBrowser = await pair();
    await json(await secondBrowser(route + '/runtime', { data: { method: 'sources.list' }, headers: grantHeader(page.token) }), 403);
    const components = await json(await call('components.list'));
    assert.deepEqual(components.workers, [worker]);
    assert.deepEqual(components.panels, [sampleID + '.panel']);
    assert.equal(components.reviewTypes[0].id, reviewType);
    assert.equal(components.collections[0].requiresReview, true);
    assert.equal((await json(await request(route + '/runtime/panels/' + sampleID + '.panel',
      { headers: grantHeader(page.token) }))).title['zh-TW'], '建置詳細資料');
    await json(await call('sources.url', { url: 'https://127.0.0.1/private' }), 422);
    const attachment = await json(await request(`/api/sessions/${session}/attachments`, {
      bytes: Buffer.from(sourceText), headers: { 'X-OEP-Filename': 'attachment.txt', 'Content-Type': 'text/plain' },
    }), 201);
    const attachSource = await json(await call('sources.reference', { session, source: attachment.id, sha256: attachment.original.sha256 }));
    assert.equal(attachSource.name, 'attachment.txt');
    const reference = await json(await request(`/api/sessions/${session}/external-sources`, {
      data: { kind: 'workspace', folder: sha256(references), path: 'reference.txt' },
    }), 201);
    const fileSource = await json(await call('sources.reference', { session, source: reference.id, sha256: reference.sha256 }));
    assert.equal(fileSource.sha256, sha256(Buffer.from(sourceText)));
    await json(await call('sources.reference', { session, source: reference.id, sha256: '0'.repeat(64) }), 422);
    const source = await json(await request(route + '/runtime/sources', { bytes: Buffer.from(sourceText),
      headers: { ...grantHeader(page.token), 'X-OEP-Filename': 'synthetic.txt' } }), 201);
    assert.equal((await json(await call('sources.read', { id: source.id }))).base64, Buffer.from(sourceText).toString('base64'));
    await json(await call('sources.read', { id: source.id }, otherPage.token, '/api/plugins/' + otherId), 403);
    const draft = await json(await call('drafts.create', { reviewType, title: 'Synthetic plugin publication' }));
    assert.equal(knowledge.reviewBase(draft.id).parent, null);
    async function start(input: Record<string, unknown>, sources: string[] = []) {
      return json(await call('jobs.start', { worker, input, sources }));
    }
    async function frames(job: { id: string }) {
      const response = await request(route + '/runtime/events/' + job.id, { headers: grantHeader(page.token) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /text\/event-stream/);
      return (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    }
    const probe = await start({ mode: 'probe', private: privateFile, outside, port: address.port, missing: source.id });
    const probeResult = (await frames(probe)).at(-1);
    assert.equal(probeResult.state, 'succeeded', JSON.stringify(probeResult));
    assert.deepEqual(probeResult.result, { privateReadDenied: true, privateWriteDenied: true, packageWriteDenied: true,
      networkDenied: true, gatewayKeyAbsent: true, sourceDenied: true, publishDenied: true });
    assert.equal(existsSync(outside), false);
    await json(await call('data.write', { path: '../escape.txt', base64: 'WA==' }), 422);

    const bad = (await frames(await start({ draft: draft.id, badEvidence: true }, [source.id]))).at(-1);
    assert.equal(bad.error, 'proposal-evidence', JSON.stringify(bad));
    assert.equal(knowledge.reviews().length, 0);
    const updates = await frames(await start({ draft: draft.id, multiple: true, model: true }, [source.id]));
    assert.deepEqual(updates.filter(({ state }) => state === 'running').map(({ percent }) => percent), [0, 25, 65]);
    const completed = updates.at(-1);
    assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
    assert.equal(completed.result.records, 2);
    assert.deepEqual(models, [{ prompt: 'Return the selected synthetic fact.', input: { source: sourceText } }]);
    assert.equal(knowledge.compareReview(completed.review).candidate.cards.length, 2);
    assert.equal(readFileSync(join(root, 'plugin-data', sampleID, 'last-input.txt'), 'utf8'), sourceText);
    assert.equal((await json(await call('reviews.status', { id: completed.review }))).status, 'pending');
    assert.equal((await json(await call('publish.request', { id: completed.review }))).status.status, 'pending');
    await json(await call('reviews.status', { id: completed.review }, otherPage.token, '/api/plugins/' + otherId), 403);
    await json(await call('reviews.approve', { id: completed.review }), 403);
    await json(await request('/api/knowledge/reviews', { data: { action: 'publish', id: completed.review } }), 422);
    await json(await request('/api/knowledge/reviews', { data: { action: 'approve', id: completed.review, edit: 0 } }));
    assert.equal(knowledge.reviewBase(draft.id).parent, null);
    const published = await json(await request('/api/knowledge/reviews', { data: { action: 'publish', id: completed.review } }));
    assert.equal(knowledge.reviewBase(draft.id).parent, published.revision);

    async function waitUntilRunning(job: { id: string }) {
      for (let attempt = 0; attempt < 800; attempt++) {
        const update = await json(await call('jobs.status', { id: job.id }));
        if (update.percent === 35 && update.state === 'running') {
          return Number(readFileSync(join(root, 'plugin-data', sampleID, 'worker.pid')));
        }
        assert.ok(['starting', 'running'].includes(update.state), JSON.stringify(update));
        await delay(35);
      }
      assert.fail('Worker never emitted startup progress');
    }
    const cancelled = await start({ mode: 'hang' });
    const cancelledPid = await waitUntilRunning(cancelled);
    await json(await call('jobs.cancel', { id: cancelled.id }));
    assert.equal((await frames(cancelled)).at(-1).state, 'cancelled');
    assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' });

    const expired = await start({ mode: 'hang' });
    const expiredPid = await waitUntilRunning(expired);
    assert.equal((await frames(expired)).at(-1).state, 'timed-out');
    assert.throws(() => process.kill(expiredPid, 0), { code: 'ESRCH' });

    const disabled = await start({ mode: 'hang' });
    const disabledPid = await waitUntilRunning(disabled);
    await json(await request(route + '/disable', { data: {} }));
    await json(await call('components.list'), 403);
    for (let attempt = 0; readdirSync(join(root, 'plugin-workers')).length && attempt < 90; attempt++) await delay(100);
    assert.throws(() => process.kill(disabledPid, 0), { code: 'ESRCH' });
    assert.deepEqual(readdirSync(join(root, 'plugin-workers')), []);
    await json(await request(route + '/uninstall', { data: {} }));
    assert.equal(knowledge.reviewBase(draft.id).parent, published.revision);
    assert.equal(readFileSync(join(root, 'plugin-data', sampleID, 'last-input.txt'), 'utf8'), sourceText);
  } finally {
    if (previousKey === undefined) delete process.env.OEP_LITELLM_API_KEY;
    else process.env.OEP_LITELLM_API_KEY = previousKey;
    network.close();
    await app.close();
    knowledge.close();
  }
});

test('a lost adapter owner stops Python and the next startup retires its staging directory', { timeout: 60_000 }, async () => {
  const root = dataDirectory();
  const archive = join(root, 'worker.oepplugin');
  writeFileSync(archive, samplePlugin({ runtime: true }));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'tests/fixtures/plugins/worker-owner.ts', root, archive],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    const pid = await Promise.race([
      new Promise<number>((resolve, reject) => {
        child.once('message', (message) => typeof message === 'number' ? resolve(message) : reject(new Error(String(message))));
        child.once('exit', () => reject(new Error('Worker owner exited before starting Python')));
      }),
      delay(40_000, undefined, { ref: false }).then(() => { throw new Error('Worker owner startup timed out'); }),
    ]);
    const probe = join(root, 'plugin-workers');
    assert.equal(readdirSync(probe).length, 1);
    child.kill();
    await closed;
    await recoverPythonJobs(root);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(readdirSync(probe), []);
  } finally {
    child.kill();
    await closed;
  }
});
