import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { ExternalExecutor } from '../../apps/adapter/src/runs/external-executor.ts';
import type { Provider } from '../../apps/adapter/src/runs/external-ledger.ts';
import type { LoginPrompt } from '../../apps/adapter/src/runs/external-login.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import { webAPI } from '../e2e/web-api.ts';
import { subscriptionHelper } from '../fixtures/external-helpers/subscription.ts';

test('subscription login uses the CLI callback, device code and private stdin without exposing credentials', { timeout: 35_000 }, async () => {
  const folder = mkdtempSync(join(process.env.OEP_DATA_DIR ?? tmpdir(), 'oep-subscription-'));
  const root = join(folder, 'oep');
  const profile = join(folder, 'synthetic-helper-profile');
  mkdirSync(root);
  const fixture = subscriptionHelper(root, profile);
  const logs: string[] = [];
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic', aliases: ['synthetic'], builtInAliases: ['synthetic'],
    endpoint: { request: async () => new Response(null, { status: 503 }) },
    redact: (value: string) => { logs.push(value); return value; },
  } as unknown as Runtime;
  const executor = new ExternalExecutor(root, fixture.isolation);
  const server = await startAdapter(root, runtime, () => {}, false, undefined, undefined, { executor });
  try {
    const api = await webAPI(server.pairURL());
    const otherBrowser = await webAPI(server.pairURL());
    const settings = '/api/settings/external-helpers';
    const auth = settings + '/auth';
    const control = auth + '/prompt';
    const codex = 'codex_cli';
    const claude = 'claude_code';
    const json = async (response: Response, status = 200) => {
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.equal(body.includes(fixture.syntheticCredential), false);
      assert.equal(body.includes(fixture.code), false);
      return JSON.parse(body);
    };
    const post = async (path: string, data: object, status?: number) => json(await api.post(path, data), status);
    const recheck = (provider: Provider) => post(settings + '/recheck', { provider });
    const logout = async (provider: Provider) => {
      assert.equal((await post(auth, { provider, action: 'logout' })).login, 'signedOut');
      assert.equal(existsSync(join(profile, provider + '.credential')), false);
    };
    const start = (provider: Provider, action = 'cli', signal?: AbortSignal) => {
      const exchange = randomUUID();
      const result = api.post(auth, { provider, action, exchange }, signal);
      void result.catch(() => {});
      const poll = (predicate: (prompt: LoginPrompt) => unknown = (prompt) => prompt.url) => until(async () => {
        const prompt: LoginPrompt = await post(control, { exchange, action: 'poll' });
        return predicate(prompt) ? prompt : undefined;
      }, 7_000).catch((cause) => { throw new Error(`Timed out waiting for ${provider} ${action} prompt state`, { cause }); });
      return { exchange, result, poll };
    };
    const callback = (prompt: LoginPrompt) => {
      const url = new URL(prompt.url!);
      assert.equal(url.origin, 'https://auth.openai.com');
      return url.searchParams.get('redirect_uri')! + '?code=synthetic';
    };

    assert.equal((await recheck(codex)).login, 'signedOut');
    assert.equal((await post(auth, { provider: claude, action: 'cli', exchange: randomUUID() }, 409)).errorDetail.code, 'external-terms-required');
    await post(settings, { provider: claude, revision: 1, enabled: false, confirmEachRun: false, termsConfirmed: true });

    const local = start(codex);
    const browserUrl = callback(await local.poll());
    assert.deepEqual(await json(await otherBrowser.post(control, { exchange: local.exchange, action: 'poll' })), {});
    assert.equal((await post(auth, { provider: codex, action: 'cli', exchange: randomUUID() }, 409)).errorDetail.code, 'external-auth-busy');
    assert.equal((await post(control, { exchange: local.exchange, action: 'code', code: fixture.code }, 409)).errorDetail.code,
      'external-auth-code-unavailable');
    assert.equal((await fetch(browserUrl)).status, 200);
    assert.equal((await json(await local.result)).login, 'signedIn');
    assert.deepEqual(await post(control, { exchange: local.exchange, action: 'poll' }), {});
    await logout(codex);

    const device = start(codex, 'device');
    const devicePrompt = await device.poll(({ deviceCode }) => deviceCode);
    assert.deepEqual(devicePrompt, { url: 'https://auth.openai.com/codex/device', deviceCode: 'ABCD-EFGH' });
    fixture.approveDevice();
    assert.equal((await json(await device.result)).login, 'signedIn');
    await logout(codex);

    const paste = start(claude);
    const pastePrompt = await paste.poll(({ url, pasteCode }) => url && pasteCode);
    assert.equal(new URL(pastePrompt.url!).origin, 'https://claude.com');
    assert.equal((await json(await otherBrowser.post(control, { exchange: paste.exchange, action: 'code', code: fixture.code }), 409)).errorDetail.code,
      'external-auth-code-unavailable');
    assert.equal((await post(control, { exchange: paste.exchange, action: 'code', code: 'line\nbreak' }, 400)).errorDetail.code, 'external-invalid-input');
    await post(control, { exchange: paste.exchange, action: 'code', code: fixture.code });
    const signedIn = await json(await paste.result);
    assert.equal(signedIn.login, 'signedIn');
    assert.equal(signedIn.account, 'owner@example.test');
    fixture.mode(claude, 'expired');
    assert.equal((await recheck(claude)).login, 'reauthRequired');
    fixture.mode(claude, 'text');
    assert.equal((await recheck(claude)).login, 'signedIn');
    await logout(claude);

    fixture.mode(codex, 'failure');
    assert.equal((await json(await start(codex).result, 409)).errorDetail.code, 'external-auth-failed');
    fixture.mode(codex, 'timeout');
    assert.equal((await json(await start(codex).result, 409)).errorDetail.code, 'external-auth-timeout');
    fixture.mode(codex, 'old');
    assert.equal((await json(await start(codex).result, 409)).errorDetail.code, 'external-auth-setup-required');
    fixture.mode(codex, '');

    const cancelled = start(codex);
    const cancelledUrl = callback(await cancelled.poll());
    await post(control, { exchange: cancelled.exchange, action: 'cancel' });
    assert.equal((await json(await cancelled.result, 409)).errorDetail.code, 'external-auth-cancelled');
    await assert.rejects(fetch(cancelledUrl), TypeError);
    const controller = new AbortController();
    const dropped = start(codex, 'cli', controller.signal);
    const droppedUrl = callback(await dropped.poll());
    controller.abort();
    await assert.rejects(dropped.result, { name: 'AbortError' });
    await dropped.poll((prompt) => !prompt.url);
    await assert.rejects(fetch(droppedUrl), TypeError);
    assert.equal((await recheck(codex)).login, 'signedOut');

    assert.equal(logs.some((text) => text.includes(fixture.syntheticCredential) || text.includes(fixture.code)), false);
    for (const file of readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())) {
      const contents = readFileSync(join(file.parentPath, file.name));
      assert.equal(contents.includes(fixture.syntheticCredential) || contents.includes(fixture.code), false, file.name);
    }
  } finally {
    await server.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
