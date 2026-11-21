import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { TelegramApi, TelegramPoller } from '../../apps/adapter/src/telegram/poller.ts';
import { TelegramRouter } from '../../apps/adapter/src/telegram/router.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { BiScheduler } from '../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../packages/knowledge/src/ingest.ts';
import { KnowledgeAsk } from '../../packages/knowledge/src/ask.ts';

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
  assert.equal(inbox.pending('bi'), undefined);
  assert.equal(inbox.offset('bi'), 0);
  inbox.db.close();
  crash('persist');
  crash('effect');
  crash('send');
  inbox = new TelegramInbox(ledger);
  assert.equal(inbox.offset('bi'), 2);
  assert.equal(inbox.pending('bi')?.id, 1);
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
    const start = Date.now();
    await Promise.all([main.step(signal, start), bi.step(signal, start)]);
    assert.equal(inbox.db.prepare("SELECT state FROM outbox WHERE bot='bi' AND id='update-1'").get()?.state, 'indeterminate');
    assert.equal(inbox.db.prepare("SELECT due FROM outbox WHERE bot='main' AND id='update-1'").get()?.due, start + 5000);
    await main.step(signal, start + 4999);
    assert(!sends.some((send) => send.bot === 'botfake-main'));
    for (let index = 0; index < 27; index++) {
      await Promise.all([main.step(signal, start + 5000 + index), bi.step(signal, start + 5000 + index)]);
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
    router.supplement(2, 'Synthetic manual supplement');
    assert.equal(store.reconciliation().effects.length, 24);
    store.decideReview('telegram-bi-2', 0, 'approved');
    store.publishReview('telegram-bi-2');
    store.publishReview('telegram-bi-2');
    assert.equal(store.reconciliation().intents.length, 1);
    let modelCalls = 0;
    const ask = new KnowledgeAsk(store, async () => {
      modelCalls++;
      return { failure: 'unavailable', retryable: false };
    });
    const readRuntime = { knowledge: { reviewStore: store, ask } } as unknown as Runtime;
    const mainRouter = new TelegramRouter(inbox, readRuntime, undefined!, undefined!);
    const question = JSON.stringify({ text: '/ask intake-telegram-2 Synthetic manual supplement' });
    assert.match(await mainRouter.handle({ id: 100, topic: 1, bot: 'main', payload: question }, signal) ?? '', /沒有可核對/);
    assert.equal(modelCalls, 0);
    inbox.notifyReviews(store.reconciliation().intents);
    inbox.notifyReviews(store.reconciliation().intents);
    await bi.step(signal, start + 6000);
    assert.equal(sends.filter((send) => send.text.startsWith('BI 審核')).length, 1);
    assert(!sends.some((send) => send.text === 'Synthetic unknown delivery'));
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
