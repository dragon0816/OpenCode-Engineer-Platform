import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { legacyAllowlistRef, managedTelegramCredentialRef } from '../../apps/adapter/src/channels/accounts.ts';
import type { Update } from '../../apps/adapter/src/telegram/inbox.ts';
import { TelegramApi } from '../../apps/adapter/src/telegram/poller.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';

test('token setup writes only generated User-scope references, after private owner confirmation', async () => {
  const parent = process.env.OEP_DATA_DIR ?? join(process.cwd(), '.phase0');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'token-'));
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic', aliases: ['synthetic'], builtInAliases: ['synthetic'],
    endpoint: { request: async () => new Response(null, { status: 503 }) }, redact: (value: string) => value,
  } as unknown as Runtime;
  const token = '83:' + randomUUID();
  const replacement = '83:' + randomUUID();
  const credentials = new Map<string, string>();
  const updates: Update[] = [];
  const replies: string[] = [];
  const writes: string[] = [];
  class SyntheticTelegram extends TelegramApi {
    override async call<T>(method: string, input: { offset?: number }): Promise<T> {
      if (method === 'getMe') return { id: 83, is_bot: true, username: 'SyntheticSetupBot' } as T;
      assert.equal(method, 'getUpdates');
      return updates.filter(({ update_id }) => update_id >= (input.offset ?? 0)) as T;
    }
  }
  const server = await startAdapter(root, runtime, () => {}, true, undefined, {
    readCredentials: (names) => Object.fromEntries(names.map((name) => [name, credentials.get(name)])),
    writeCredential(name, value) {
      writes.push(name);
      if (value === null) credentials.delete(name);
      else credentials.set(name, value);
    },
    createApi: (value) => new SyntheticTelegram(value),
  });
  try {
    async function pair() {
      const launch = new URL(server.pairURL());
      const { origin } = launch;
      const headers = { origin, 'content-type': 'application/json' };
      const pair = await fetch(origin + '/api/pair', { method: 'POST', headers,
        body: JSON.stringify({ ticket: new URLSearchParams(launch.hash.slice(1)).get('pair') }) });
      assert.equal(pair.status, 200);
      return { origin, headers: { ...headers, cookie: pair.headers.get('set-cookie')!.split(';')[0], 'x-oep-csrf': (await pair.json()).csrf } };
    }
    const owner = await pair();
    const other = await pair();
    const path = '/api/settings/channels';
    async function call(input?: object, status = 200, browser = owner, endpoint = path) {
      const response = await fetch(browser.origin + endpoint, { headers: browser.headers, ...(input && {
        method: 'POST', body: JSON.stringify(input),
      }) });
      const raw = await response.text();
      replies.push(raw);
      assert.equal(response.status, status);
      return JSON.parse(raw);
    }
    const now = Math.floor(Date.now() / 1000);
    const started = await call({ action: 'setup-start', token });
    assert.deepEqual({ ...started, setupId: typeof started.setupId }, { setupId: 'string', botName: '@SyntheticSetupBot', ownerRequired: true });
    assert.equal(writes.length, 0);
    const setup = { setupId: started.setupId };
    assert.equal((await call({ ...setup, action: 'setup-check' }, 409, other)).errorDetail.code, 'channel-setup-expired');
    const update = (id: number, type: string, date: number, isBot = false): Update => ({ update_id: id,
      message: { date, chat: { id: 17, type }, from: { id: 17, is_bot: isBot, first_name: 'Synthetic Owner' }, text: '/start' } });
    updates.push(update(1, 'private', now - 60), update(2, 'group', now + 2), update(3, 'private', now + 2, true));
    assert.equal((await call({ ...setup, action: 'setup-check' })).ownerName, undefined);
    const save = { ...setup, action: 'setup-save', agentId: 'main', confirmed: true };
    assert.equal((await call(save, 409)).errorDetail.code, 'channel-owner-confirmation');
    updates.push(update(4, 'private', now + 2));
    assert.equal((await call({ ...setup, action: 'setup-check' })).ownerName, 'Synthetic Owner');
    assert.equal((await call(save, 409)).errorDetail.code, 'channel-owner-confirmation');
    assert.equal(writes.length, 0);
    const { accounts } = await call({ ...save, ownerConfirmed: true });
    const bot = accounts.find(({ botName }: { botName: string }) => botName === '@SyntheticSetupBot');
    assert.equal(bot.agentId, 'main');
    assert.equal(bot.verified, true);
    assert.equal(writes.length, 2);
    const ref = writes.find((name) => managedTelegramCredentialRef.test(name));
    assert.ok(ref, 'Expected a generated credential name');
    assert.ok(credentials.get(ref) === token, 'User-scope credential did not receive the token');
    assert.equal(credentials.get(legacyAllowlistRef), '17');
    using registry = new DatabaseSync(join(root, 'web.sqlite'), { readOnly: true });
    assert.equal(registry.prepare('SELECT credential_ref FROM channel_accounts WHERE id=?').get(bot.accountId)?.credential_ref, ref);
    using inbox = new DatabaseSync(join(root, 'telegram.sqlite'), { readOnly: true });
    assert.equal(inbox.prepare('SELECT checkpoint FROM channel_cursors WHERE account_id=?').get(bot.accountId)?.checkpoint, '5');
    const rotated = await call({ action: 'setup-start', token: replacement, accountId: bot.accountId, bindingRevision: bot.bindingRevision });
    assert.equal(rotated.ownerRequired, false);
    const { accounts: rotatedAccounts } = await call({ action: 'setup-save', setupId: rotated.setupId, confirmed: true });
    assert.equal(rotatedAccounts.find(({ accountId }: { accountId: string }) => accountId === bot.accountId).bindingRevision, bot.bindingRevision + 1);
    assert.ok(credentials.get(ref) === replacement, 'Token replacement did not update User scope');
    await call();
    await call(undefined, 200, owner, '/api/agents/main');
    assert.ok(replies.every((reply) => ![token, replacement, ref, legacyAllowlistRef].some((secret) => reply.includes(secret))),
      'A token or credential reference was returned by the workbench API');
    for (const file of readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())) {
      const data = readFileSync(join(file.parentPath, file.name));
      assert.ok(![token, replacement].some((secret) => data.includes(secret)), 'Token leaked to local data or logs');
    }
    await call({ action: 'remove', accountId: bot.accountId, bindingRevision: bot.bindingRevision + 1, confirmed: true });
    assert.equal(credentials.has(ref), false);
    assert.equal((await call()).accounts.some(({ accountId }: { accountId: string }) => accountId === bot.accountId), false);
    const addAgain = await call({ action: 'setup-start', token: replacement });
    const reenrolled = await call({ action: 'setup-save', setupId: addAgain.setupId, confirmed: true, agentId: 'main' });
    assert.ok(reenrolled.accounts.some(({ accountId }: { accountId: string }) => accountId === bot.accountId));
  } finally { await server.close(); }
});
