import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { maxWorkAttempts, TelegramApi, TelegramPoller, workDeadline } from '../../apps/adapter/src/telegram/poller.ts';
import { TelegramRouter } from '../../apps/adapter/src/telegram/router.ts';
import { ChatService } from '../../apps/adapter/src/http/chat.ts';
import { ModelSeat } from '../../apps/adapter/src/opencode/model-seat.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { startKnowledgeRuntime } from '../../apps/launcher/src/knowledge.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { BiScheduler } from '../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../packages/knowledge/src/ingest.ts';

function folder() {
  mkdirSync('.phase0', { recursive: true });
  return mkdtempSync(resolve('.phase0', 'telegram-'));
}

test('two fake bots reconcile duplicate updates, process crashes, blocked links, timeout and 429', async () => {
  const root = folder();
  const ledger = join(root, 'telegram.sqlite');
  const knowledge = join(root, 'knowledge.sqlite');
  const crash = (mode: string) => {
    const child = spawnSync(process.execPath, ['tests/integration/telegram-worker.ts', mode, ledger, knowledge], { encoding: 'utf8' });
    assert.equal(child.status, 79, child.stderr);
  };
  crash('before');
  let inbox = new TelegramInbox(ledger);
  assert.equal(inbox.next('bi', 'work', Date.now()), undefined);
  assert.equal(inbox.offset('bi'), 0);
  inbox.db.close();
  crash('persist');
  crash('effect');
  crash('send');
  inbox = new TelegramInbox(ledger);
  assert.equal(inbox.offset('bi'), 2);
  assert.equal(inbox.next('bi', 'work', Date.now())?.id, 1);
  assert.equal(inbox.db.prepare("SELECT state FROM outbox WHERE id='crash-send'").get()?.state, 'indeterminate');
  const store = new KnowledgeStore(knowledge);
  assert.equal(store.reconciliation().effects.length, 1);
  const runtime = { knowledge: { reviewStore: store } } as unknown as Runtime;
  const updates = Array.from({ length: 24 }, (_, index) => ({
    update_id: index + 1, message: {
      chat: { type: 'private', id: 42 }, from: { id: 42 }, message_thread_id: index % 2 + 1,
      text: index === 0 ? 'Synthetic crash intake' : index === 1 ? 'https://example.invalid/unreadable' : 'Synthetic intake ' + index,
      ...(index === 2 && { document: { file_id: 'synthetic-file', file_name: 'sample.txt', file_size: 14 } }),
    },
  }));
  updates.push({ update_id: 25, message: { chat: { type: 'private', id: 42 }, from: { id: 43 }, text: 'rejected', message_thread_id: 1 } });
  updates.push({ update_id: 26, message: { chat: { type: 'group', id: 42 }, from: { id: 42 }, text: 'rejected', message_thread_id: 1 } });
  const sends: { bot: string; text: string; topic: number }[] = [];
  let throttled = false;
  let timedOut = false;
  const offsets = new Map<string, number[]>();
  const server = createServer(async (req, res) => {
    if (req.url === '/file/botfake-bi/documents/sample.txt') { res.end('Synthetic file'); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const [, bot, method] = req.url!.split('/');
    const reply = (data: object) => res.end(JSON.stringify(data));
    if (method === 'getUpdates') {
      assert.equal(input.timeout, 25);
      offsets.set(bot, [...offsets.get(bot) ?? [], input.offset]);
      reply({ ok: true, result: updates });
      return;
    }
    if (method === 'getFile' && bot === 'botfake-bi') {
      assert.equal(input.file_id, 'synthetic-file');
      reply({ ok: true, result: { file_path: 'documents/sample.txt', file_size: 14 } });
      return;
    }
    assert.equal(input.chat_id, '42');
    if (bot === 'botfake-main' && !throttled) {
      throttled = true;
      res.statusCode = 429;
      reply({ ok: false, parameters: { retry_after: 5 } });
      return;
    }
    if (bot === 'botfake-bi' && !timedOut) {
      timedOut = true;
      sends.push({ bot, text: input.text, topic: input.message_thread_id ?? 0 });
      return;
    }
    sends.push({ bot, text: input.text, topic: input.message_thread_id ?? 0 });
    reply({ ok: true, result: {} });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const base = 'http://127.0.0.1:' + address.port;
    const main = new TelegramPoller('main', '42', new TelegramApi('fake-main', base), inbox, async (row) => 'MAIN ' + row.id);
    const biApi = new TelegramApi('fake-bi', base, 250);
    const router = new TelegramRouter(inbox, runtime, undefined!, undefined!, biApi);
    const bi = new TelegramPoller('bi', '42', biApi, inbox,
      (row, signal) => router.handle(row, signal));
    const signal = new AbortController().signal;
    const step = async (poller: TelegramPoller, now: number) => {
      const clock = () => now;
      await poller.poll(signal, clock);
      await Promise.all([poller.process('work', signal, clock), poller.process('command', signal, clock)]);
      await poller.deliver(signal, clock);
    };
    const start = Date.now();
    await Promise.all([step(main, start), step(bi, start)]);
    assert.equal(inbox.db.prepare("SELECT state FROM outbox WHERE bot='bi' AND id='update-1'").get()?.state, 'indeterminate');
    assert.equal(inbox.db.prepare("SELECT due FROM outbox WHERE bot='main' AND id='update-1'").get()?.due, start + 5000);
    await step(main, start + 4999);
    assert(!sends.some((send) => send.bot === 'botfake-main'));
    for (let index = 0; index < 27; index++) {
      await Promise.all([step(main, start + 5000 + index), step(bi, start + 5000 + index)]);
    }
    assert.equal(inbox.offset('main'), 27);
    assert.equal(inbox.offset('bi'), 27);
    assert.deepEqual(offsets.get('botfake-main')?.slice(0, 2), [0, 27]);
    assert.deepEqual(offsets.get('botfake-bi')?.slice(0, 2), [2, 27]);
    assert.equal(inbox.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE done=1').get()?.n, 48);
    assert.equal(inbox.db.prepare("SELECT state FROM bi_sources WHERE id=2").get()?.state, 'blocked');
    assert.equal(inbox.db.prepare("SELECT ref FROM bi_sources WHERE id=2").get()?.ref, 'https://example.invalid/unreadable');
    assert.equal(store.reconciliation().effects.length, 23);
    assert.equal(Buffer.from(inbox.db.prepare('SELECT bytes FROM bi_sources WHERE id=3').get()?.bytes as Uint8Array).toString(), 'Synthetic file');
    assert.equal(store.reconciliation().intents.length, 0);
    assert(sends.every((send) => send.bot === 'botfake-main' ? send.text.startsWith('MAIN ') : !send.text.startsWith('MAIN ')));
    assert.equal(sends.filter((send) => send.text === 'MAIN 1' && send.topic === 1).length, 1);
    assert.equal(new Set(sends.map((send) => JSON.stringify(send))).size, sends.length);
    await router.supplement(2, 'Synthetic manual supplement', signal);
    assert.equal(store.reconciliation().effects.length, 24);
    store.decideReview('telegram-bi-2', 0, 'approved');
    store.publishReview('telegram-bi-2');
    store.publishReview('telegram-bi-2');
    assert.equal(store.reconciliation().intents.length, 1);
    let modelCalls = 0;
    const alias = 'synthetic-telegram';
    const seat = new ModelSeat();
    const profile = join(root, 'profile');
    mkdirSync(profile);
    const reader = await startKnowledgeRuntime(profile, root, {
      url: 'http://example.invalid/v1', key: randomUUID(), alias, aliases: [alias],
      fetch: async () => { modelCalls++; return new Response(null, { status: 400 }); },
    }, () => alias, seat);
    const policy = new WebStore(join(root, 'web.sqlite'));
    const sessions = new WebStore(join(root, 'telegram-chat.sqlite'));
    const readRuntime = { knowledge: reader, alias, aliases: [alias], modelSeat: seat } as unknown as Runtime;
    const chat = new ChatService(sessions, readRuntime, root, join(root, 'turns.jsonl'), () => {}, policy);
    try {
      assert.ok(policy.executionKnowledgeReads('main', 'legacy-default').includes('intake-telegram-2'));
      const mainRouter = new TelegramRouter(inbox, readRuntime, chat, sessions);
      const question = JSON.stringify({ text: '/ask intake-telegram-2 Synthetic manual supplement' });
      assert.match(await mainRouter.handle({ id: 100, topic: 1, bot: 'main', payload: question }, signal) ?? '', /沒有可核對/);
      assert.equal(modelCalls, 0);
    } finally {
      await chat.close();
      sessions.close();
      policy.close();
      await reader.close();
    }
    inbox.notifyReviews(store.reconciliation().intents);
    inbox.notifyReviews(store.reconciliation().intents);
    await step(bi, start + 6000);
    assert.equal(sends.filter((send) => send.text.startsWith('BI 審核')).length, 1);
    assert(!sends.some((send) => send.text === 'Synthetic unknown delivery'));
    inbox.resend('bi', 'crash-send');
    assert.throws(() => inbox.resend('bi', 'crash-send'));
    await bi.deliver(signal, () => start + 6001);
    assert.equal(sends.filter((send) => send.text === 'Synthetic unknown delivery').length, 1);
    assert.throws(() => inbox.resend('bi', 'crash-send'));
  } finally {
    server.closeAllConnections();
    server.close();
    inbox.db.close();
    store.close();
    rmSync(root, { recursive: true });
  }
});

test('scheduled and Run Now share the BI effect across restart, a DST fold and missed runs', () => {
  const root = folder();
  const store = new KnowledgeStore(join(root, 'knowledge.sqlite'));
  const ledger = join(root, 'telegram.sqlite');
  let inbox = new TelegramInbox(ledger);
  try {
    const schema = store.installReviewSchema('sample', 'sample', '1', ['setting']);
    const candidate: Candidate = {
      vault: { id: 'sample', kind: 'bi', title: 'Synthetic' }, schema: schema.sha256,
      sources: [{ id: 'source', ref: 'sample.md', original: 'Amber', markdown: 'Amber' }],
      cards: [{ id: 'card', key: 'card', type: 'record', title: 'Synthetic', version: '1', fields: { setting: 'Amber' } }],
      relationships: [], evidence: [{ sourceId: 'source', cardId: 'card', field: 'setting', start: 0, end: 5 }],
    };
    store.enqueueBi('immediate', candidate);
    store.runBi('immediate');
    let scheduler = new BiScheduler(inbox.db, store);
    const at = Date.parse('2026-11-01T05:30:00Z');
    scheduler.save('daily', 'America/New_York', '01:30', candidate, at - 120_000);
    scheduler.state('daily', 'active', at - 120_000);
    scheduler.runNow('daily', at);
    inbox.db.close();
    const child = spawnSync(process.execPath, ['tests/integration/telegram-worker.ts', 'schedule',
      ledger, join(root, 'knowledge.sqlite'), String(at)], { encoding: 'utf8' });
    assert.equal(child.status, 79, child.stderr);
    inbox = new TelegramInbox(ledger);
    scheduler = new BiScheduler(inbox.db, store);
    scheduler.reconcile(at);
    scheduler.reconcile(at + 3_600_000);
    assert.equal(scheduler.list().occurrences.length, 1);
    assert.equal(store.reconciliation().effects.length, 2);
    scheduler.reconcile(at + 3 * 86_400_000 + 3_600_000);
    assert.equal(store.reconciliation().effects.length, 3);
    assert(scheduler.list().occurrences.some((row) => row.state === 'expired'));
    scheduler.state('daily', 'paused', at + 4 * 86_400_000);
    scheduler.reconcile(at + 5 * 86_400_000);
    assert.equal(store.reconciliation().effects.length, 3);
  } finally {
    inbox.db.close();
    store.close();
    rmSync(root, { recursive: true });
  }
});

test('poison and stalled work finish durably while commands and other topics progress', async () => {
  const root = folder();
  const file = join(root, 'telegram.sqlite');
  const now = Date.now();
  let inbox = new TelegramInbox(file);
  const message = (id: number, text: string, topic = 1) => ({ update_id: id, message: {
    chat: { type: 'private', id: 42 }, from: { id: 42 }, message_thread_id: topic, text,
  } });
  try {
    const updates = [message(1, 'poison'), message(2, 'stall'), message(3, 'later'),
      message(4, '/ask synthetic question'), message(5, 'transient', 2)];
    inbox.admit('main', '42', updates, now);
    inbox.db.close();
    const child = spawnSync(process.execPath, ['tests/integration/telegram-worker.ts',
      'attempt', file, join(root, 'knowledge.sqlite'), String(now)], { encoding: 'utf8' });
    assert.equal(child.status, 79, child.stderr);
    inbox = new TelegramInbox(file);
    let transient = 0;
    let poison = 0;
    let stall = 0;
    const poller = new TelegramPoller('main', '42', new TelegramApi('fake-main'), inbox, async (row) => {
      if (row.id === 1) { poison++; throw new Error('Synthetic handler failure'); }
      if (row.id === 2) {
        if (++stall === 1) return undefined;
        return new Promise<string>(() => {});
      }
      if (row.id === 5 && ++transient === 1) throw new Error('Synthetic transient failure');
      return 'Synthetic reply ' + row.id;
    });
    const signal = new AbortController().signal;
    await poller.process('command', signal, () => now);
    await poller.process('work', signal, () => now);
    await poller.process('work', signal, () => now + 6000);
    await poller.process('work', signal, () => now + 6000);
    assert.equal(transient, 2);
    for (let attempt = 2; attempt < maxWorkAttempts; attempt++) {
      await poller.process('work', signal, () => now + attempt * 6000);
    }
    assert.equal(poison, maxWorkAttempts - 1);
    const afterPoison = now + maxWorkAttempts * 6000;
    await poller.process('work', signal, () => afterPoison);
    inbox.admit('main', '42', [message(6, '/ask bypass active attempt')], afterPoison);
    // Keep the test event loop alive while the uncooperative handler reaches its abort deadline.
    const keepAlive = setTimeout(() => {}, 250);
    try {
      const stalled = poller.process('work', signal, () => afterPoison + workDeadline - 20);
      await poller.process('command', signal, () => afterPoison + workDeadline - 20);
      assert.equal(inbox.db.prepare('SELECT done FROM inbox WHERE id=6').get()?.done, 1);
      await stalled;
    } finally { clearTimeout(keepAlive); }
    await poller.process('work', signal, () => afterPoison + workDeadline);
    inbox.admit('main', '42', updates, now + workDeadline * 3);
    await poller.process('work', signal, () => afterPoison + workDeadline + 1);
    const rows = inbox.db.prepare('SELECT id,firstSeen,failed,done,payload FROM inbox ORDER BY id').all();
    assert.deepEqual(rows.map((row) => [row.id, row.failed, row.done]), [
      [1, 1, 1], [2, 1, 1], [3, 0, 1], [4, 0, 1], [5, 0, 1], [6, 0, 1],
    ]);
    assert.equal(rows[0].firstSeen, now);
    assert.match(String(rows[0].payload), /poison/);
    assert.deepEqual(inbox.db.prepare('SELECT id FROM outbox ORDER BY rowid').all().map((row) => row.id),
      ['update-4', 'update-5', 'update-1', 'update-6', 'update-2', 'update-3']);
    assert.match(String(inbox.db.prepare("SELECT text FROM outbox WHERE id='update-2'").get()?.text), /已保留原始收件/);
  } finally {
    inbox.db.close();
    rmSync(root, { recursive: true });
  }
});

test('long polling stays single-flight, leaves delivery independent, and aborts on shutdown', async () => {
  const inbox = new TelegramInbox(':memory:');
  const stop = new AbortController();
  let requests = 0;
  let delivered = 0;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url?.endsWith('/getUpdates')) {
      requests++;
      assert.equal(JSON.parse(raw).timeout, 25);
      entered();
      return;
    }
    delivered++;
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const poller = new TelegramPoller('bi', '42', new TelegramApi('fake-bi', 'http://127.0.0.1:' + address.port),
      inbox, async () => 'Synthetic status');
    const poll = poller.poll(stop.signal);
    await waiting;
    await poller.poll(stop.signal);
    inbox.admit('bi', '42', [{ update_id: 1, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/status' } }]);
    await poller.process('command', stop.signal);
    await poller.deliver(stop.signal);
    assert.equal(requests, 1);
    assert.equal(delivered, 1);
    stop.abort();
    await poll;
  } finally {
    stop.abort();
    server.closeAllConnections();
    server.close();
    inbox.db.close();
  }
});

test('targeted intake stages verified change sets and blocks fabricated quotes or unavailable models', async () => {
  const root = folder();
  const inbox = new TelegramInbox(join(root, 'telegram.sqlite'));
  const store = new KnowledgeStore(join(root, 'knowledge.sqlite'));
  try {
    const schema = store.installReviewSchema('target', 'target', '1', ['setting']);
    const text = 'Synthetic verified setting is amber.';
    store.stage('target-seed', {
      vault: { id: 'target', kind: 'bi', title: 'Synthetic target' }, schema: schema.sha256,
      sources: [{ id: 'seed', ref: 'seed.md', original: text, markdown: text }],
      cards: [{ id: 'seed', key: 'seed', type: 'record', title: 'Seed', version: '1', fields: { setting: 'amber' } }],
      relationships: [], evidence: [{ sourceId: 'seed', cardId: 'seed', field: 'setting', start: 0, end: text.length }],
    });
    store.decideReview('target-seed', 0, 'approved');
    store.publishReview('target-seed');
    let mode = 'valid';
    let calls = 0;
    const runtime = { knowledge: { reviewStore: store, propose: async () => {
      calls++;
      if (mode === 'unavailable') return { failure: 'unavailable', retryable: false };
      return { content: JSON.stringify({ title: 'Synthetic proposal', fields: {
        setting: { value: 'amber', quote: mode === 'valid' ? 'amber' : 'fabricated' },
      } }) };
    } } } as unknown as Runtime;
    const router = new TelegramRouter(inbox, runtime, undefined!, undefined!);
    assert.throws(() => router.configure('sample', [], 'missing'));
    router.configure('sample', [], 'target');
    const signal = new AbortController().signal;
    const receive = (id: number) => router.handle({ bot: 'bi', id, topic: 0, payload: JSON.stringify({ text }) }, signal);
    const parent = store.reviewBase('target').parent;
    assert.match(await receive(1) ?? '', /已送審/);
    assert.match(await receive(1) ?? '', /已送審/);
    assert.equal(calls, 1);
    assert.equal(store.reviews().find((row) => row.id === 'telegram-bi-1')?.status, 'pending');
    assert.throws(() => store.publishReview('telegram-bi-1'));
    assert.equal(store.reviewBase('target').parent, parent);
    mode = 'fabricated';
    assert.match(await receive(2) ?? '', /需要補件/);
    assert.match(String(inbox.db.prepare('SELECT reason FROM bi_sources WHERE id=2').get()?.reason), /引文/);
    assert(!store.hasReview('telegram-bi-2', 'target'));
    mode = 'unavailable';
    assert.match(await receive(3) ?? '', /需要補件/);
    assert(!store.hasReview('telegram-bi-3', 'target'));
    mode = 'valid';
    await router.supplement(2, text, signal);
    assert(store.hasReview('telegram-bi-2', 'target'));
    assert.equal(store.reviewBase('target').cards.length, 1);
  } finally {
    inbox.db.close();
    store.close();
    rmSync(root, { recursive: true });
  }
});
