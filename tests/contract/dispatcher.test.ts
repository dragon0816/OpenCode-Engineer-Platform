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

function seed(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'oep-dispatcher-'));
  const file = join(path, 'web.sqlite');
  const web = new WebStore(file);
  t.after(() => {
    web.close();
    rmSync(path, { recursive: true, force: true });
  });
  return { file, items: web.workItems };
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
