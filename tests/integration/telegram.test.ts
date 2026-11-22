import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { maxWorkAttempts, TelegramApi, TelegramPoller, TelegramTransport, workDeadline } from '../../apps/adapter/src/telegram/poller.ts';
import { legacyChannels } from '../../apps/adapter/src/channels/accounts.ts';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { TelegramRouter } from '../../apps/adapter/src/telegram/router.ts';
import { ChatService } from '../../apps/adapter/src/http/chat.ts';
import { ModelSeat } from '../../apps/adapter/src/opencode/model-seat.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { startKnowledgeRuntime } from '../../apps/launcher/src/knowledge.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { BiScheduler } from '../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../packages/knowledge/src/ingest.ts';
import { until } from '../../scripts/phase0/probe-http.ts';

function folder() {
  mkdirSync('.phase0', { recursive: true });
  return mkdtempSync(resolve('.phase0', 'telegram-'));
}

test('paired channel settings verify a third bot, route specialist sessions and drain before rebinding', async () => {
  const data = folder();
  const root = join(data, 'web');
  mkdirSync(root);
  const store = new WebStore(join(root, 'web.sqlite'));
  store.close();
  {
    using db = new DatabaseSync(join(root, 'web.sqlite'));
    db.exec(`INSERT INTO agents VALUES
      ('analysis','specialist',NULL,'active','Synthetic specialist','','',NULL,NULL,'synthetic-specialist','en',1,0,0);
      INSERT INTO agent_workspaces VALUES ('analysis','analysis','managed','web/agents/analysis',NULL,1,'unclassified',0);`);
  }
  const alias = 'synthetic-primary';
  const primaryRef = 'OEP_TELEGRAM_THIRD_BOT_TOKEN';
  const alternateRef = 'OEP_TELEGRAM_ROTATED_BOT_TOKEN';
  const credentials: Record<string, string> = {
    OEP_TELEGRAM_ALLOWED_USER_ID: '42',
    OEP_TELEGRAM_MAIN_BOT_TOKEN: '71:fixture-main',
    OEP_TELEGRAM_BI_BOT_TOKEN: '72:fixture-bi',
    [primaryRef]: '73:fixture-third',
    [alternateRef]: '73:fixture-rotation',
  };
  const firstPrompt = Promise.withResolvers<void>();
  const releaseStalePoll = Promise.withResolvers<void>();
  let thirdEvent = 1;
  let conflicted = false;
  let holdPoll = false;
  let stalePollPending = false;
  const receives = new Map<number, number[]>();
  const sends: { bot: number; text: string; topic: number }[] = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const [, path, method] = req.url!.split('/');
    const id = Number(path.slice(3).split(':')[0]);
    const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
    if (method === 'getMe') reply({ id, is_bot: true });
    else if (method === 'getUpdates') {
      receives.set(id, [...receives.get(id) ?? [], input.offset]);
      if (id === 73 && conflicted) {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      let update_id = id === 73 ? thirdEvent : 1;
      if (id === 73 && holdPoll) {
        holdPoll = false;
        stalePollPending = true;
        await releaseStalePoll.promise;
        update_id = 99;
      }
      reply([{ update_id, message: { chat: { type: 'private', id: 42 }, from: { id: 42 }, message_thread_id: 7,
        text: id === 72 ? '/status' : 'Synthetic input ' + id + ' event ' + update_id } }]);
    } else {
      sends.push({ bot: id, text: input.text, topic: input.message_thread_id });
      reply({ message_id: sends.length });
    }
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  const address = provider.address();
  assert(address && typeof address === 'object');
  type UserMessage = { id: string; type: 'user'; text: string };
  type AssistantMessage = { id: string; type: 'assistant'; content: { type: 'text'; text: string }[] };
  type SessionInput = { agent: string; location: { directory: string }; model: { id: string } };
  const profiles = new Map<string, SessionInput & { id: string }>();
  const messages = new Map<string, (UserMessage | AssistantMessage)[]>();
  const prompts: { sessionID: string; text: string }[] = [];
  const runtime = {
    root, alias, aliases: [alias, 'synthetic-specialist'], modelSeat: new ModelSeat(),
    gatewayCursor: () => 0, gatewaySince: () => [{ status: 200, output: 'text' }], setTurnBoundary: () => {},
    redact: (value: string) => value, endpoint: { request: async () => new Response(null, { status: 503 }) },
    client: {
      session: {
        create: async (input: SessionInput) => {
          const session = { ...input, id: randomUUID() };
          profiles.set(session.id, session);
          return session;
        },
        get: async ({ sessionID }: { sessionID: string }) => ({ ...profiles.get(sessionID), outcome: 'succeeded' }),
        prompt: async ({ sessionID, id, text }: { sessionID: string; id: string; text: string }) => {
          prompts.push({ sessionID, text });
          if (text.startsWith('Synthetic input 73 event 1')) await firstPrompt.promise;
          const reply = text.includes('Reply to the user in English.') ? 'English synthetic answer' : '合成回答';
          messages.set(sessionID, [{ id: randomUUID(), type: 'assistant', content: [{ type: 'text', text: reply }] },
            { id, type: 'user', text }, ...messages.get(sessionID) ?? []]);
          return { id, sessionID };
        },
        update: async () => {}, active: async () => ({}), inbox: { list: async () => [] }, interrupt: async () => {},
      },
      permission: { list: async () => [] },
      message: { list: async ({ sessionID, type }: { sessionID: string; type?: string }) =>
        ({ data: (messages.get(sessionID) ?? []).filter((item) => !type || type === item.type) }) },
    },
  } as unknown as Runtime;
  const start = () => startAdapter(root, runtime, () => {}, true, undefined, {
    readCredentials: (names) => Object.fromEntries(names.map((name) => [name, credentials[name]])),
    createApi: (value) => new TelegramApi(value, 'http://127.0.0.1:' + address.port),
  });
  let adapter: Awaited<ReturnType<typeof start>> | undefined;
  const ready = (check: () => unknown) => until(async () => check() ? true : undefined, 16_000);
  try {
    adapter = await start();
    const url = new URL(adapter.pairURL());
    const { origin } = url;
    const endpoint = origin + '/api/settings/channels';
    const requestHeaders = { origin, 'content-type': 'application/json' };
    const pair = await fetch(origin + '/api/pair', { method: 'POST', headers: requestHeaders,
      body: JSON.stringify({ ticket: new URLSearchParams(url.hash.slice(1)).get('pair') }) });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await pair.json();
    const headers = { ...requestHeaders, cookie, 'x-oep-csrf': csrf };
    const post = (input: object, authorized = headers) =>
      fetch(endpoint, { method: 'POST', headers: authorized, body: JSON.stringify(input) });
    const list = async () => (await (await fetch(endpoint, { headers })).json()).accounts as {
      accountId: string; agentId: string; credentialRef: string; bindingRevision: number; pollState: string; replyLocale: string;
    }[];
    const expect = async (response: Response, status: number, code: string) => {
      assert.equal(response.status, status);
      assert.equal((await response.json()).errorDetail.code, code);
    };
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { cookie } })).status, 403);
    assert.equal((await post({ action: 'verify', credentialRef: primaryRef }, { ...headers, cookie: '' })).status, 401);
    assert.equal((await post({ action: 'verify', credentialRef: primaryRef }, { ...headers, 'x-oep-csrf': '' })).status, 403);
    await expect(await post({ action: 'verify', credentialRef: primaryRef, token: credentials[primaryRef] }), 400, 'channel-settings-invalid');
    assert.deepEqual(await (await post({ action: 'verify', credentialRef: primaryRef })).json(), { verified: true });
    const bind = { action: 'bind', credentialRef: primaryRef, agentId: 'analysis' };
    await expect(await post(bind), 409, 'channel-confirmation-required');
    const created = await Promise.all([primaryRef, alternateRef].map((credentialRef) => post({ ...bind, credentialRef, confirmed: true })));
    assert.deepEqual(created.map((response) => response.status).sort(), [200, 409]);
    const account = (await list()).find(({ agentId }) => agentId === 'analysis')!;
    assert.equal(account.replyLocale, 'en');
    const availableRef = [primaryRef, alternateRef].find((ref) => ref !== account.credentialRef)!;
    const duplicate = await created.find((response) => response.status === 409)!.json();
    assert.equal(duplicate.errorDetail.code, 'CHANNEL_ACCOUNT_IN_USE');
    assert.deepEqual(duplicate.errorDetail.params, { accountId: account.accountId, agentId: 'analysis' });
    await expect(await post({ action: 'verify', credentialRef: availableRef }), 409, 'CHANNEL_ACCOUNT_IN_USE');
    assert(!(await (await fetch(endpoint, { headers })).text()).includes(credentials[account.credentialRef]));
    await ready(() => prompts.some(({ text }) => text.startsWith('Synthetic input 73 event 1')));
    const rebind = { action: 'rebind', accountId: account.accountId, agentId: 'main', credentialRef: availableRef,
      bindingRevision: account.bindingRevision, confirmed: true };
    await expect(await post(rebind), 409, 'channel-binding-busy');
    firstPrompt.resolve();
    await ready(() => [71, 72, 73].every((bot) => sends.some((send) => send.bot === bot)));
    assert.deepEqual(sends.find(({ bot }) => bot === 73), { bot: 73, text: 'English synthetic answer', topic: 7 });
    assert.deepEqual(sends.find(({ bot }) => bot === 71), { bot: 71, text: '合成回答', topic: 7 });
    assert.match(sends.find(({ bot }) => bot === 72)?.text ?? '', /BI 工作/);
    const specialist = profiles.get(prompts.find(({ text }) => text.startsWith('Synthetic input 73 event 1'))!.sessionID)!;
    assert.equal(specialist.model.id, 'synthetic-specialist');
    assert.equal(dirname(specialist.location.directory), join(root, 'agents/analysis/model-work'));
    holdPoll = true;
    await ready(() => stalePollPending);
    assert.equal((await post(rebind)).status, 200);
    releaseStalePoll.resolve();
    await expect(await post(rebind), 409, 'channel-binding-stale');
    const namesFile = join(data, 'credential-references.json');
    const exported = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/windows/data-snapshot.mjs',
      'credentials', data, namesFile], { encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);
    assert.deepEqual(JSON.parse(readFileSync(namesFile, 'utf8')), [availableRef]);
    {
      const spool = new TelegramInbox(join(root, 'telegram.sqlite'), false);
      try {
        spool.enqueueOutbound({ accountId: account.accountId, agentId: 'analysis', bindingRevision: 1,
          conversationKey: 'chat:42:topic:7', effectKey: 'late-original-reply', locale: 'en', text: 'Late original reply' });
      } finally { spool.db.close(); }
    }
    thirdEvent = 2;
    await ready(() => sends.some(({ text }) => text === 'Late original reply') && sends.filter(({ bot }) => bot === 73).length === 3);
    {
      using db = new DatabaseSync(join(root, 'telegram-chat.sqlite'), { readOnly: true });
      const owners = db.prepare(`SELECT agent_id,workspace_id,origin,channel_account_id,conversation_key,binding_revision
        FROM session_ownership ORDER BY channel_account_id,binding_revision`).all().map((row) => Object.values(row));
      assert.equal(owners.length, 3);
      assert(owners.some((row) => JSON.stringify(row) === JSON.stringify(
        ['analysis', 'analysis', 'channel', account.accountId, 'chat:42:topic:7', 1])));
      assert(owners.some((row) => JSON.stringify(row) === JSON.stringify(
        ['main', 'legacy-default', 'channel', account.accountId, 'chat:42:topic:7', 2])));
      assert(owners.some((row) => row[3] === 'telegram-main' && row[4] === 'topic:7'));
    }
    {
      using db = new DatabaseSync(join(root, 'telegram.sqlite'), { readOnly: true });
      assert.deepEqual(Object.values(db.prepare("SELECT agent_id,binding_revision,state FROM channel_outbound WHERE effect_key='late-original-reply'").get()!),
        ['analysis', 1, 'sent']);
      assert.equal(db.prepare("SELECT count(*) AS n FROM channel_inbound WHERE event_key='1' AND status='handled'").get()?.n, 3);
      assert.equal(db.prepare("SELECT count(*) AS n FROM channel_inbound WHERE event_key='99'").get()?.n, 0);
      assert.equal(db.prepare('SELECT checkpoint FROM channel_cursors WHERE account_id=?').get(account.accountId)?.checkpoint, '3');
    }
    conflicted = true;
    await until(async () => (await list()).some(({ accountId, pollState }) =>
      accountId === account.accountId && pollState === 'poll-conflict') ? true : undefined, 4_000);
    const unbind = { action: 'unbind', accountId: account.accountId, bindingRevision: 2, confirmed: true };
    assert.equal((await post(unbind)).status, 200);
    assert.equal((await list()).find(({ accountId }) => accountId === account.accountId)?.pollState, 'disabled');
    conflicted = false;
    assert.equal((await post({ ...unbind, action: 'bind', bindingRevision: 3 })).status, 200);
    await adapter.close();
    adapter = undefined;
    const polls = receives.get(73)!.length;
    adapter = await start();
    await ready(() => (receives.get(73)?.length ?? 0) > polls);
    assert.equal(receives.get(73)!.at(-1), 3);
    assert.equal(prompts.length, 3);
    assert.equal(sends.length, 5);
  } finally {
    firstPrompt.resolve();
    releaseStalePoll.resolve();
    await adapter?.close();
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    rmSync(data, { recursive: true });
  }
});

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
  assert.equal(inbox.db.prepare("SELECT state FROM channel_outbound WHERE effect_key='crash-send'").get()?.state, 'indeterminate');
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
    assert.equal(inbox.db.prepare("SELECT state FROM channel_outbound WHERE account_id='telegram-bi' AND effect_key='update-1'").get()?.state, 'indeterminate');
    assert.equal(inbox.db.prepare("SELECT due_at AS due FROM channel_outbound WHERE account_id='telegram-main' AND effect_key='update-1'").get()?.due, start + 5000);
    await step(main, start + 4999);
    assert(!sends.some((send) => send.bot === 'botfake-main'));
    for (let index = 0; index < 27; index++) {
      await Promise.all([step(main, start + 5000 + index), step(bi, start + 5000 + index)]);
    }
    assert.equal(inbox.offset('main'), 27);
    assert.equal(inbox.offset('bi'), 27);
    assert.deepEqual(offsets.get('botfake-main')?.slice(0, 2), [0, 27]);
    assert.deepEqual(offsets.get('botfake-bi')?.slice(0, 2), [2, 27]);
    assert.equal(inbox.db.prepare("SELECT COUNT(*) AS n FROM channel_inbound WHERE status='handled'").get()?.n, 48);
    assert.equal(inbox.db.prepare(`SELECT count(*) AS total FROM channel_inbound WHERE status='rejected'
      AND payload IS NULL AND conversation_key='' AND reason_code='unauthorized-update'`).get()?.total, 4);
    assert.equal(inbox.db.prepare("SELECT state FROM bi_sources WHERE id=2").get()?.state, 'blocked');
    assert.equal(inbox.db.prepare("SELECT ref FROM bi_sources WHERE id=2").get()?.ref, 'https://example.invalid/unreadable');
    assert.equal(store.reconciliation().effects.length, 23);
    assert.equal(Buffer.from(inbox.db.prepare('SELECT bytes FROM bi_sources WHERE id=3').get()?.bytes as Uint8Array).toString(), 'Synthetic file');
    assert.equal(store.reconciliation().intents.length, 0);
    assert(sends.every((send) => send.bot === 'botfake-main' ? send.text.startsWith('MAIN ') : !send.text.startsWith('MAIN ')));
    assert.equal(sends.filter((send) => send.text === 'MAIN 1' && send.topic === 1).length, 1);
    assert.equal(new Set(sends.map((send) => JSON.stringify(send))).size, sends.length);
    await router.bi.supplement(2, 'Synthetic manual supplement', signal);
    assert.equal(store.reconciliation().effects.length, 24);
    const webRoot = join(root, 'workbench');
    mkdirSync(webRoot);
    const adapter = await startAdapter(webRoot, {
      ...runtime, root: webRoot, endpoint: { request: async () => new Response(null, { status: 503 }) },
    } as unknown as Runtime, () => {}, false);
    try {
      const url = new URL(adapter.pairURL());
      const { origin } = url;
      const ticket = new URLSearchParams(url.hash.slice(1)).get('pair');
      const headers = { origin, 'content-type': 'application/json' };
      const reviews = origin + '/api/knowledge/reviews';
      const review = (action: string, authorization = {}) => fetch(reviews, {
        method: 'POST', headers: { ...headers, ...authorization },
        body: JSON.stringify({ action, id: 'telegram-bi-2', edit: 0 }),
      });
      assert.equal((await fetch(reviews)).status, 401);
      assert.equal((await review('approve')).status, 401);
      const pair = await fetch(origin + '/api/pair', { method: 'POST', headers, body: JSON.stringify({ ticket }) });
      assert.equal(pair.status, 200);
      const cookie = pair.headers.get('set-cookie')!.split(';')[0];
      const { csrf } = await pair.json();
      const authorization = { cookie, 'x-oep-csrf': csrf };
      assert.equal((await review('approve', { cookie })).status, 403);
      const response = await fetch(reviews, { headers: { cookie } });
      assert.equal(response.status, 200);
      const pending = (await response.json()).reviews.find(({ id }: { id: string }) => id === 'telegram-bi-2');
      assert.equal(pending?.status, 'pending');
      assert.equal(pending?.agentSource, 'BI 資料處理');
      assert.equal(pending?.agentId, 'bi');
      assert.equal(pending?.origin, 'telegram');
      assert.equal(store.snapshot('intake-telegram-2'), undefined);
      assert.equal((await review('publish', authorization)).status, 422);
      assert.equal((await review('approve', authorization)).status, 200);
      assert.equal((await review('publish', authorization)).status, 200);
      assert.equal((await review('publish', authorization)).status, 200);
      assert.ok(store.snapshot('intake-telegram-2'));
    } finally { await adapter.close(); }
    assert.equal(store.reconciliation().intents.length, 1);
    assert.equal(store.reviews().find(({ id }) => id === 'telegram-bi-2')?.agentSource, 'BI 資料處理');
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
    assert.equal(sends.find((send) => send.text.startsWith('BI 審核'))?.topic, 2);
    assert.equal(sends.find((send) => send.text.startsWith('BI 審核'))?.bot, 'botfake-bi');
    assert(!sends.some((send) => send.text === 'Synthetic unknown delivery'));
    inbox.resend('bi', 'crash-send');
    assert.throws(() => inbox.resend('bi', 'crash-send'));
    await bi.deliver(signal, () => start + 6001);
    assert.equal(sends.filter((send) => send.text === 'Synthetic unknown delivery').length, 1);
    assert.throws(() => inbox.resend('bi', 'crash-send'));
    const recovered = new TelegramInbox(ledger);
    try {
      const restarted = new TelegramPoller('bi', '42', biApi, recovered, (row, stop) => router.handle(row, stop));
      recovered.notifyReviews(store.reconciliation().intents);
      await restarted.deliver(signal, () => start + 6002);
      assert.equal(sends.filter((send) => send.text.startsWith('BI 審核')).length, 1);
      recovered.notifyReviews([{ review: 'unknown-origin', sourceKey: null, destination: null }]);
      recovered.notifyReviews([{ review: 'unknown-origin', sourceKey: null, destination: null }]);
      assert.deepEqual(recovered.db.prepare(`SELECT account_id, conversation_key, binding_revision, agent_id
        FROM channel_outbound WHERE effect_key='review-unknown-origin'`).all().map((row) => ({ ...row })),
      [{ account_id: 'telegram-bi', conversation_key: 'topic:0', binding_revision: 1, agent_id: 'bi' }]);
    } finally { recovered.db.close(); }
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
      assert.equal(inbox.db.prepare("SELECT status='handled' AS done FROM channel_inbound WHERE event_key='6'").get()?.done, 1);
      await stalled;
    } finally { clearTimeout(keepAlive); }
    await poller.process('work', signal, () => afterPoison + workDeadline);
    inbox.admit('main', '42', updates, now + workDeadline * 3);
    await poller.process('work', signal, () => afterPoison + workDeadline + 1);
    const rows = inbox.db.prepare(`SELECT CAST(event_key AS INTEGER) AS id,received_at AS firstSeen,
      status='failed' AS failed,status IN ('handled','failed') AS done,payload FROM channel_inbound ORDER BY id`).all();
    assert.deepEqual(rows.map((row) => [row.id, row.failed, row.done]), [
      [1, 1, 1], [2, 1, 1], [3, 0, 1], [4, 0, 1], [5, 0, 1], [6, 0, 1],
    ]);
    assert.equal(rows[0].firstSeen, now);
    assert.match(String(rows[0].payload), /poison/);
    assert.deepEqual(inbox.db.prepare('SELECT effect_key AS id FROM channel_outbound ORDER BY rowid').all().map((row) => row.id),
      ['update-4', 'update-5', 'update-1', 'update-6', 'update-2', 'update-3']);
    assert.match(String(inbox.db.prepare("SELECT json_extract(payload, '$.text') AS text FROM channel_outbound WHERE effect_key='update-2'").get()?.text), /已保留原始收件/);
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
    assert.throws(() => router.bi.configure('sample', [], 'missing'));
    router.bi.configure('sample', [], 'target');
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
    const command = (id: number, topic: number, text: string) =>
      router.handle({ bot: 'bi', id, topic, payload: JSON.stringify({ text }) }, signal);
    assert.match(await command(4, 1, '/status 2') ?? '', /無法存取/);
    assert.match(await command(5, 0, '/status 2') ?? '', /需要補件/);
    assert.match(await command(6, 1, '/supplement 2 ' + text) ?? '', /無法存取/);
    assert.match(await command(7, 0, '/supplement 2 ' + text) ?? '', /已送審/);
    assert.match(await command(8, 0, '/publish telegram-bi-2') ?? '', /工作台/);
    assert(store.hasReview('telegram-bi-2', 'target'));
    assert.equal(store.reviews().find((row) => row.id === 'telegram-bi-2')?.status, 'pending');
    assert.equal(store.reviewBase('target').cards.length, 1);
  } finally {
    inbox.db.close();
    store.close();
    rmSync(root, { recursive: true });
  }
});

test('canonical bot verification rejects a duplicate account and stops polling on a provider conflict', async () => {
  const inbox = new TelegramInbox(':memory:');
  const ledger = new WebStore(':memory:');
  const stop = new AbortController();
  let polls = 0;
  let sends = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the synthetic request. */ }
    if (req.url?.endsWith('/getMe')) {
      res.end(JSON.stringify({ ok: true, result: { id: 17, is_bot: true } }));
    } else if (req.url?.endsWith('/getUpdates')) {
      polls++;
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error_code: 409 }));
    } else {
      sends++;
      res.end(JSON.stringify({ ok: true, result: { message_id: 88 } }));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const base = 'http://127.0.0.1:' + address.port;
    const clients = [new TelegramApi('fake-first', base), new TelegramApi('fake-second', base)];
    let seals = 0;
    const results = await Promise.allSettled(legacyChannels.map(async (account, index) => {
      const identity = await new TelegramTransport(account.bot, '42', clients[index]).verifyAccount(stop.signal);
      return ledger.verifyLegacyChannel(account, createHash('sha256').update(identity.identity).digest('hex'), () => {
        seals++;
        return true;
      });
    }));
    assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value === true).length, 1);
    const conflict = results.find((result) => result.status === 'rejected');
    assert.equal(conflict?.reason.message, 'CHANNEL_ACCOUNT_IN_USE');
    assert.equal(seals, 1);

    inbox.notify('main', 'prior-effect', 7, 'Synthetic queued reply');
    const poller = new TelegramPoller('main', '42', clients[0], inbox, async () => 'Synthetic');
    await poller.poll(stop.signal);
    await poller.poll(stop.signal);
    await poller.deliver(stop.signal);
    assert.equal(poller.pollConflict, true);
    assert.equal(polls, 1);
    assert.equal(sends, 1);
    assert.equal(inbox.db.prepare('SELECT provider_receipt FROM channel_outbound').get()?.provider_receipt, '88');
  } finally {
    stop.abort();
    server.closeAllConnections();
    server.close();
    ledger.close();
    inbox.db.close();
  }
});

test('channel replies use the agent locale and spool destinations stay pinned across account revisions', async () => {
  const inbox = new TelegramInbox(':memory:');
  const router = new TelegramRouter(inbox, {} as Runtime, undefined!, undefined!, undefined,
    (bot) => bot === 'main' ? 'en' : 'zh-TW');
  const signal = new AbortController().signal;
  try {
    assert.equal(await router.handle({ bot: 'main', id: 1, topic: 7, payload: '{}' }, signal), 'Enter a text message.');
    assert.match(await router.handle({ bot: 'bi', id: 1, topic: 7, payload: '{"text":"/status"}' }, signal) ?? '', /BI 工作/);
    const specialist = { accountId: 'synthetic-specialist', agentId: 'first', bindingRevision: 1 };
    const later = { ...specialist, agentId: 'second', bindingRevision: 2 };
    const original = { ...specialist, conversationKey: 'topic:7', effectKey: 'update-1', locale: 'en', text: 'Delayed reply' } as const;
    inbox.enqueueOutbound(original);
    inbox.enqueueOutbound({ ...original, text: 'Duplicate' });
    inbox.enqueueOutbound({ ...original, accountId: 'telegram-main', agentId: 'main', text: 'Same topic, other bot' });
    assert.equal(inbox.claimOutbound(later, 600_000), undefined);
    assert.deepEqual(inbox.claimOutbound(specialist, 600_000), { ...original, attempts: 1 });
    assert.equal(inbox.claimOutbound({ accountId: 'telegram-main', agentId: 'main', bindingRevision: 1 }, 600_000)?.text,
      'Same topic, other bot');
  } finally { inbox.db.close(); }
});
