import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ModelSeat } from '../../apps/adapter/src/opencode/model-seat.ts';
import { Dispatcher } from '../../apps/adapter/src/runs/dispatcher.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import type { WorkRequest } from '../../apps/adapter/src/runs/work-items.ts';
import { BiService } from '../../apps/adapter/src/bi/service.ts';
import { dispatchBi } from '../../apps/adapter/src/bi/dispatch.ts';
import { BiScheduler } from '../../packages/knowledge/src/jobs/scheduler.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import type { Candidate } from '../../packages/knowledge/src/ingest.ts';
import { dispatchTelegram } from '../../apps/adapter/src/telegram/dispatch.ts';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import type { TelegramAccounts } from '../../apps/adapter/src/telegram/accounts.ts';
import { TelegramRouter } from '../../apps/adapter/src/telegram/router.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { startAdapter } from '../../apps/adapter/src/main.ts';

function seed(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'oep-dispatcher-'));
  const file = join(path, 'web.sqlite');
  const web = new WebStore(file);
  t.after(() => {
    web.close();
    rmSync(path, { recursive: true, force: true });
  });
  return { file, path, web, items: web.workItems };
}

function request(id: string, source: WorkRequest['source'] = 'direct', agentId = 'main',
  effectClass: WorkRequest['effectClass'] = 'write', serialKey?: string): WorkRequest {
  return { id, agentId, source, sourceKey: id, effectClass, payload: { kind: 'test', serialKey } };
}

test('claims ready work in per-agent priority and FIFO order and never preempts a running write', (t) => {
  const { items } = seed(t);
  for (const [id, source, at] of [
    ['schedule', 'schedule', 1], ['delegation', 'delegation', 2], ['direct-b', 'direct', 4],
    ['direct-a', 'direct', 4], ['direct-c', 'direct', 3],
  ] as const) items.enqueue(request(id, source), at);
  for (const id of ['direct-c', 'direct-a', 'direct-b', 'delegation', 'schedule']) {
    const lease = items.claim(() => true, 5)!;
    assert.equal(lease.id, id);
    assert.equal(items.claim(() => true, 5), undefined);
    assert.equal(items.finish(lease, 'succeeded'), true);
  }
  items.enqueue(request('started-schedule', 'schedule'), 6);
  const running = items.claim(() => true, 6)!;
  items.enqueue(request('later-direct'), 7);
  assert.equal(items.claim(() => true, 7), undefined);
  assert.equal(items.get(running.id)?.state, 'running');
  assert.equal(items.finish(running, 'succeeded'), true);
  assert.equal(items.claim(() => true, 7)?.id, 'later-direct');
});

test('enforces the lease token and a partial unique write index including indeterminate outcomes', (t) => {
  const { items, file } = seed(t);
  items.enqueue(request('held'), 0);
  items.enqueue(request('second'), 1);
  const work = items.claim(() => true, 2)!;
  assert.equal(items.finish({ ...work, leaseId: 'stale' }, 'succeeded'), false);
  assert.equal(items.finish(work, 'indeterminate'), true);
  assert.equal(items.claim(() => true, 700_000), undefined);
  using db = new DatabaseSync(file);
  assert.throws(() => db.exec(`UPDATE agent_work_items SET state='running',lease_id='forged',lease_until=0
    WHERE id='second'`), /UNIQUE constraint failed/);
  assert.equal(items.resolve(work.id, 'stale', 'failed'), false);
  assert.equal(items.resolve(work.id, work.leaseId, 'failed'), true);
  assert.equal(items.claim(() => true, 700_000)?.id, 'second');
});

test('uses the owner delegation queue budget and leaves ordinary direct work unexpired', (t) => {
  const { items, file } = seed(t);
  assert.equal(items.enqueue(request('default', 'delegation'), 10).item.expiresAt, 600_010);
  using db = new DatabaseSync(file);
  db.exec('UPDATE delegation_budget_settings SET queue_ms=123');
  assert.equal(items.enqueue(request('custom', 'delegation'), 10).item.expiresAt, 133);
  items.enqueue(request('direct'), 10);
  assert.deepEqual(items.expire(132), []);
  assert.equal(items.expire(133)[0]?.id, 'custom');
  assert.equal(items.get('custom')?.state, 'timed_out');
  assert.equal(items.get('direct')?.state, 'queued');
});

test('accepts other agents and verified reads concurrently while model work waits for one seat', async (t) => {
  const { items } = seed(t);
  const queue = new Dispatcher(items);
  const seat = new ModelSeat();
  const accepted: string[] = [];
  const modeled: string[] = [];
  const { promise: release, resolve } = Promise.withResolvers<void>();
  queue.register('test', { async execute(item, start) {
    accepted.push(item.id);
    await seat.run(async () => {
      start();
      modeled.push(item.id);
      if (item.id === 'first') await release;
    });
    return { state: 'succeeded' };
  } });
  await queue.start();
  try {
    queue.enqueue(request('first'));
    queue.enqueue(request('second', 'direct', 'bi'));
    queue.enqueue(request('third', 'direct', 'main', 'verified_read'));
    queue.enqueue(request('fourth'));
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(accepted, ['first', 'second', 'third']);
    assert.deepEqual(modeled, ['first']);
    assert.equal(items.get('fourth')?.state, 'queued');
    resolve();
    await queue.wait('fourth');
    assert.deepEqual(modeled, ['first', 'second', 'third', 'fourth']);
  } finally {
    resolve();
    await queue.close();
  }
});

test('recovery requeues an unsent claim, preserves an unknown lease, and accepts an owner resolution', async (t) => {
  const { items } = seed(t);
  items.enqueue(request('unsent', 'direct', 'bi'), 0);
  items.enqueue(request('unknown'), 1);
  const unsent = items.claim(() => true, 2)!;
  const unknown = items.claim(() => true, 2)!;
  items.markStarted(unknown);
  const queue = new Dispatcher(items, () => 999_000);
  queue.register('test', {
    async execute(item, start) {
      assert.notEqual(item.leaseId, unsent.leaseId);
      start();
      return { state: 'succeeded' };
    },
    async recover(item) {
      assert.equal(item.id, unknown.id);
      return undefined;
    },
  });
  await queue.start();
  try {
    assert.equal((await queue.wait('unsent')).state, 'succeeded');
    assert.equal(items.get('unknown')?.state, 'indeterminate');
    queue.enqueue(request('blocked'));
    assert.equal(await queue.resolve('unknown', 'stale', 'failed'), false);
    assert.equal(items.get('blocked')?.state, 'queued');
    assert.equal(await queue.resolve('unknown', unknown.leaseId, 'failed'), true);
    assert.equal((await queue.wait('blocked')).state, 'succeeded');
  } finally {
    await queue.close();
  }
});

test('serializes work sharing a conversation even if one item is a verified read', (t) => {
  const { items } = seed(t);
  items.enqueue(request('first', 'direct', 'main', 'write', 'conversation:1'), 0);
  items.enqueue(request('second', 'direct', 'main', 'verified_read', 'conversation:1'), 1);
  items.enqueue(request('third', 'direct', 'main', 'verified_read', 'conversation:2'), 2);
  const first = items.claim(() => true, 3)!;
  assert.equal(first.id, 'first');
  assert.equal(items.claim(() => true, 3)?.id, 'third');
  assert.equal(items.claim(() => true, 3), undefined);
  assert.equal(items.finish(first, 'succeeded'), true);
  assert.equal(items.claim(() => true, 3)?.id, 'second');
});

test('scheduled and Run Now triggers share one dispatcher item and one BI effect across the DST fold', async (t) => {
  const { path, items } = seed(t);
  const inbox = new TelegramInbox(join(path, 'telegram.sqlite'));
  const store = new KnowledgeStore(join(path, 'knowledge.sqlite'));
  const queue = new Dispatcher(items);
  const jobs = dispatchBi(queue, new BiService(inbox), store);
  const scheduler = new BiScheduler(inbox.db, store, jobs.occurrence);
  const schema = store.installReviewSchema('sample', 'sample', '1', ['setting']);
  const candidate: Candidate = {
    vault: { id: 'sample', kind: 'bi', title: 'Synthetic' }, schema: schema.sha256,
    sources: [{ id: 's', ref: 'sample.md', original: 'Amber', markdown: 'Amber' }],
    cards: [{ id: 'card', key: 'card', type: 'record', title: 'Synthetic', version: '1', fields: { setting: 'Amber' } }],
    relationships: [], evidence: [{ sourceId: 's', cardId: 'card', field: 'setting', start: 0, end: 5 }],
  };
  try {
    const at = Date.parse('2026-11-01T05:30:00Z');
    scheduler.save('daily', 'America/New_York', '01:30', candidate, at - 120_000);
    scheduler.state('daily', 'active', at - 120_000);
    scheduler.reconcile(at);
    const job = scheduler.runNow('daily', at);
    const queued = items.find('schedule', 'bi-job:' + job)!;
    assert.equal(queued.state, 'queued');
    assert.equal(queued.scheduleRef, 'daily');
    assert.equal(store.reconciliation().effects.length, 0);
    await queue.start();
    assert.equal((await queue.wait(queued.id)).state, 'succeeded');
    scheduler.reconcile(at + 3_600_000);
    assert.equal(scheduler.runNow('daily', at + 3_600_000), job);
    assert.equal(items.find('schedule', 'bi-job:' + job)?.id, queued.id);
    assert.deepEqual(scheduler.list().occurrences.map(({ wall, state }) => [wall, state]), [['2026-11-01T01:30', 'awaiting_review']]);
    assert.deepEqual(store.reconciliation().effects.map(({ job }) => job), [job]);
  } finally {
    await queue.close();
    inbox.db.close();
    store.close();
  }
});

test('the production Telegram handoff preserves one conversation across lanes while other topics progress', async (t) => {
  const { path, items } = seed(t);
  const inbox = new TelegramInbox(join(path, 'telegram.sqlite'));
  const queue = new Dispatcher(items);
  const router = new TelegramRouter(inbox, {} as Runtime, undefined!, undefined!);
  const stop = new AbortController();
  const accounts = { connections: new Map([['telegram-bi', {
    account: { agentId: 'bi', bindingRevision: 1 }, stop, redact: (text: string) => text,
  }]]) } as unknown as TelegramAccounts;
  const channel = dispatchTelegram(queue, inbox, undefined!, router, accounts, () => 'en', (text) => text);
  const now = Date.now();
  const binding = { accountId: 'telegram-bi', agentId: 'bi', bindingRevision: 1 };
  const message = (id: number, topic: number, text: string) => ({ update_id: id, message: {
    message_thread_id: topic, chat: { id: 42, type: 'private' }, from: { id: 42 }, text,
  } });
  const item = (id: number) => items.find('direct', JSON.stringify(['telegram', binding.accountId, id]))!;
  try {
    inbox.admit('bi', '42', [message(1, 1, '/approve'), message(2, 1, '/status'), message(3, 2, '/status')], now);
    assert.equal(inbox.nextBound('bi', binding, 'command', now, true)?.id, 3);
    channel.handoff(inbox.nextBound('bi', binding, 'work', now, true)!, now, now + 120_000);
    assert.equal(inbox.nextBound('bi', binding, 'command', now, true)?.id, 3);
    channel.handoff(inbox.nextBound('bi', binding, 'command', now, true)!, now, now + 120_000);
    await queue.start();
    assert.equal((await queue.wait(item(1).id)).state, 'succeeded');
    assert.equal((await queue.wait(item(3).id)).state, 'succeeded');
    assert.equal(inbox.nextBound('bi', binding, 'command', now, true)?.id, 2);
    channel.handoff(inbox.nextBound('bi', binding, 'command', now, true)!, now, now + 120_000);
    assert.equal((await queue.wait(item(2).id)).state, 'succeeded');
    const replies = inbox.db.prepare("SELECT effect_key FROM channel_outbound WHERE conversation_key='topic:1' ORDER BY rowid").all();
    assert.deepEqual(replies.map(({ effect_key }) => effect_key), ['update-1', 'update-2']);
  } finally {
    await queue.close();
    inbox.db.close();
  }
});

test('restart inspects the turn in OpenCode and the owner API resolves it only after the runtime is idle', async (t) => {
  const { path, web, items } = seed(t);
  const { resolve: modelRan, promise: waitForModel } = Promise.withResolvers<void>();
  const modelSeat = new ModelSeat();
  const checked = new Set<string>();
  let upstreamActive = true;
  const now = Date.now();
  const session = { id: 'local-session', upstreamID: 'synthetic-session', agent: 'inspector', alias: 'synthetic', createdAt: now } as const;
  web.createSession(session);
  web.saveTurn(session.id, { id: 'run', mode: 'web-chat', state: 'accepted', createdAt: now, workspace: path,
    sessionID: session.upstreamID, submissionID: 'synthetic-submission', retries: 0, errors: [], alias: 'synthetic' }, 'synthetic');
  items.enqueue({ ...request('work'), run: { store: 'web', id: 'run' },
    payload: { kind: 'web-turn', sessionId: session.id, input: 'Synthetic private input' } });
  const lease = items.claim(() => true)!;
  items.markStarted(lease);
  web.change('run', 'running');
  const runtime = {
    root: path, alias: 'synthetic', aliases: ['synthetic'], redact: (text: string) => text, modelSeat,
    endpoint: { request: async () => new Response(null, { status: 503 }) },
    client: {
      session: {
        get: async () => ({ id: session.upstreamID }),
        active: async () => { checked.add('active'); return upstreamActive ? { [session.upstreamID]: true } : {}; },
        inbox: { list: async () => { checked.add('inbox'); return []; } },
      },
      permission: { list: async () => [] },
      message: { list: async () => { checked.add('messages'); return { data: [] }; } },
    },
  } as unknown as Runtime;
  const app = await startAdapter(path, runtime, () => {});
  try {
    assert.deepEqual(checked, new Set(['active', 'inbox', 'messages']));
    assert.equal(web.get('run').state, 'indeterminate');
    assert.equal(items.get(lease.id)?.state, 'indeterminate');
    let acquired = false;
    void modelSeat.run(async () => { acquired = true; modelRan(); });
    const launch = new URL(app.pairURL());
    const { origin } = launch;
    const url = origin + '/api/work-items';
    const post = (params: object, headers: Record<string, string> = {}) => fetch(url, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(params),
    });
    const decision = { id: lease.id, leaseId: lease.leaseId, outcome: 'cancelled' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await post(decision)).status, 401);
    const pair = await fetch(origin + '/api/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: launch.hash.slice('#pair='.length) }) });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await pair.json();
    const visible = await (await fetch(url, { headers: { cookie } })).json();
    assert.equal(visible.indeterminate[0].id, lease.id);
    assert.equal(Object.hasOwn(visible.indeterminate[0], 'payload'), false);
    assert.equal((await post(decision, { cookie })).status, 403);
    const headers = { cookie, 'x-oep-csrf': csrf };
    assert.equal((await post({ ...decision, leaseId: 'old' }, headers)).status, 409);
    assert.equal((await post(decision, headers)).status, 409);
    assert.equal(acquired, false);
    upstreamActive = false;
    assert.equal((await post(decision, headers)).status, 200);
    assert.equal(items.get(lease.id)?.state, 'cancelled');
    assert.equal(items.get(lease.id)?.leaseId, null);
    assert.equal(web.get('run').state, 'cancelled');
    await waitForModel;
  } finally {
    modelSeat.release(lease.id);
    await app.close();
  }
});
