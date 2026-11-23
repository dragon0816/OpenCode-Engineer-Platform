import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { McpOAuth } from '../../apps/adapter/src/opencode/mcp-oauth.ts';
import { mcpOAuthStorage } from '../../apps/adapter/src/opencode/mcp-oauth-storage.ts';
import { readFileTool } from '../../apps/adapter/src/opencode/permissions.ts';
import { probeOAuthMcp } from '../../apps/adapter/src/opencode/remote-mcp-broker.ts';
import { customMcpName, oauthBinding, validateCustomRemoteMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';
import type { CredentialEnvironment } from '../../apps/adapter/src/runs/custom-mcp-credentials.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import { sendRemoteMcp } from '../../scripts/windows/custom-mcp-remote.mjs';
import { syntheticOAuthMcp } from '../fixtures/mcp/oauth.ts';
import { chromium } from './chromium.ts';
import { dataDirectory } from './test-data.ts';
import { selectLocale } from './gui-locales.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const root = dataDirectory();
const profile = join(root, 'profile');
const serverRoot = join(root, 'fixture');
mkdirSync(profile);
mkdirSync(serverRoot);
const fixture = await syntheticOAuthMcp(serverRoot);
setDefaultCACertificates([...getCACertificates('default'), fixture.certificate.cert]);
const values = new Map<string, string>();
const credentials: CredentialEnvironment = {
  readCredentials: (names) => Object.fromEntries(names.map((name) => [name, values.get(name)])),
  writeCredential(name, value) { if (value === null) values.delete(name); else values.set(name, value); },
};
let consent: URL | undefined;
const openMcpBrowser = async (url: string) => { consent = new URL(url); };
const oauth = new McpOAuth(root, openMcpBrowser, credentials);
const signal = () => AbortSignal.timeout(10_000);
const identity = (value: string) => value;
const noSecrets = (content: string | Buffer) => {
  for (const secret of fixture.secrets) assert.ok(!content.includes(secret), 'Unexpected OAuth material in an output');
};
function scan(folder: string) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('chromium') || entry.name === 'fixture') continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (entry.isFile()) noSecrets(readFileSync(path));
  }
}
async function complete() {
  assert.ok(consent, 'System browser handoff received the consent URL');
  const response = await fetch(consent, { signal: signal() });
  noSecrets(await response.text());
  return response.status;
}

const source = { name: 'Synthetic OAuth', transport: 'remote', enabled: true, headers: [], localService: true,
  timeouts: { startup: 5000, catalog: 5000, execution: 5000 }, appliesToProjects: ['default'], dataScope: '' };
const staticMcp = validateCustomRemoteMcp('a'.repeat(32), { ...source, url: fixture.origin + '/mcp',
  oauth: { client: 'static', scopes: ['messages.read'] }, deniedTools: ['write_message'] }, ['default']);
const dynamicMcp = validateCustomRemoteMcp('b'.repeat(32), { ...source, url: fixture.origin + '/fallback',
  oauth: { client: 'dynamic', scopes: [] } }, ['default']);
const call = (server = staticMcp) => oauth.send(server, { jsonrpc: '2.0', id: 7, method: 'tools/call',
  params: { name: 'messages.read', arguments: { value: 7 } } }, { version: '2026-07-28' }, signal(), new Set());

let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
let adapter: Awaited<ReturnType<typeof startAdapter>> | undefined;
let page: Awaited<ReturnType<typeof chromium>> | undefined;
let signInPage: Awaited<ReturnType<typeof chromium>> | undefined;
async function stopRuntime() {
  try { await adapter?.close(); }
  finally {
    adapter = undefined;
    if (runtime) {
      const result = await runtime.stop();
      runtime = undefined;
      assert.deepEqual([result.supervisorExit, result.childExit, result.orphans], [0, 0, 0]);
    }
  }
}

try {
  oauth.configure(undefined, staticMcp, fixture.client.id, fixture.client.secret);
  fixture.noPkce(true);
  await assert.rejects(oauth.start(staticMcp), (error: { detail: { code: string } }) => error.detail.code === 'mcp-oauth-discovery');
  fixture.noPkce(false);
  fixture.wrongIssuer(true);
  await assert.rejects(oauth.start(staticMcp), (error: { detail: { code: string } }) => error.detail.code === 'mcp-oauth-discovery');
  fixture.wrongIssuer(false);
  assert.equal(consent, undefined);
  await oauth.start(staticMcp);
  const authorize = consent as unknown as URL;
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ state: 'wrong', code: 'bogus', iss: fixture.origin + '/tenant' }).toString();
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.set('state', authorize.searchParams.get('state')!);
  callback.searchParams.set('iss', fixture.origin + '/wrong');
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.delete('iss');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(fixture.stats().exchanges, 0);

  fixture.expireNext();
  assert.equal(await complete(), 200);
  assert.equal(oauth.status(staticMcp)?.state, 'signed-in');
  const catalog = await probeOAuthMcp(staticMcp, oauth, identity);
  assert.ok(catalog.some(({ name }) => name === 'messages.read'));
  noSecrets(JSON.stringify(catalog));
  assert.equal(fixture.stats().refreshes, 1);
  fixture.rejectNextAccess();
  await call();
  assert.equal(fixture.stats().refreshes, 2);
  assert.deepEqual(fixture.callNames.slice(-2), ['messages.read', 'messages.read']);
  fixture.denyScope(true);
  await assert.rejects(call(), (error: { detail: { code: string } }) => error.detail.code === 'mcp-oauth-scope');
  assert.equal(oauth.status(staticMcp)?.error, 'mcp-oauth-scope');
  fixture.denyScope(false);
  fixture.rejectNextAccess();
  fixture.denyRefresh(true);
  await assert.rejects(call(), (error: { detail: { code: string } }) => error.detail.code === 'mcp-oauth-login-required');
  assert.equal(oauth.status(staticMcp)?.state, 'reauth');
  fixture.denyRefresh(false);
  await oauth.start(staticMcp);
  assert.equal(await complete(), 200);
  const scopeChange = { ...staticMcp, oauth: { client: 'static' as const, scopes: ['messages.write'] } };
  oauth.configure(staticMcp, scopeChange, undefined, undefined);
  assert.equal(oauth.status(scopeChange)?.state, 'reauth');
  await assert.rejects(call(scopeChange));
  await oauth.start(scopeChange);
  assert.equal(await complete(), 200);
  assert.equal(fixture.requestedScopes.at(-1), 'messages.read messages.write');
  await oauth.signOut(scopeChange);
  assert.equal(fixture.stats().revocations, 1);
  assert.equal(oauth.status(scopeChange)?.state, 'signed-out');
  await assert.rejects(call(scopeChange));

  await oauth.start(dynamicMcp);
  fixture.redirectTokens(true);
  assert.equal(await complete(), 400);
  assert.ok(!fixture.paths.includes('/redirected-token'), 'Token requests refused HTTPS redirects');
  fixture.redirectTokens(false);
  await oauth.start(dynamicMcp);
  assert.equal(await complete(), 200);
  assert.deepEqual(fixture.paths.filter((path) => path.includes('well-known')).slice(-5), [
    '/.well-known/oauth-protected-resource/fallback', '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server/tenant', '/.well-known/openid-configuration/tenant', '/tenant/.well-known/openid-configuration',
  ]);
  assert.equal(fixture.requestedScopes.at(-1), 'files.read');
  assert.equal(fixture.registrations.size, 2);
  const reopened = new McpOAuth(root, openMcpBrowser, credentials);
  assert.equal(reopened.status(dynamicMcp)?.state, 'signed-in');
  assert.ok((await probeOAuthMcp(dynamicMcp, reopened, identity)).length);
  await reopened.signOut(dynamicMcp);
  reopened.close();
  assert.equal(fixture.stats().revocations, 2);
  oauth.close();
  console.log('Synthetic HTTPS OAuth verified for discovery, issuer and state checks, PKCE, static and dynamic clients, refresh, 401, scopes and revocation.');

  const requests = new Map<string, string[]>();
  let toolResult = false;
  let scopeError = false;
  let brokered = '';
  async function launch() {
    const audit = join(root, randomUUID());
    mkdirSync(audit);
    const store = new WebStore(join(root, 'web.sqlite'));
    const definitions = store.customMcpServers();
    store.close();
    runtime = await startRuntime(audit, { url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-mcp-browser',
      isolatedJob: true, mcpCredentials: credentials, openMcpBrowser,
      // The fixture transports otherwise public broker traffic through a test CA on loopback.
      remoteMcpTransport: (definition, message, session, headers, stop) =>
        sendRemoteMcp({ ...definition, localService: true }, message, session, headers, stop),
      fetch: async (_url, init) => {
        const { model, messages, tools } = JSON.parse(String(init?.body)) as WireRequest;
        noSecrets(JSON.stringify({ messages, tools }));
        if (messages.some(({ role }) => role === 'tool')) {
          if (JSON.stringify(messages).includes('policy-scope-error')) {
            assert.match(JSON.stringify(messages), /remote tool needs additional permissions/);
            scopeError = true;
          } else {
            assert.match(JSON.stringify(messages), /Synthetic message/);
            toolResult = true;
          }
        } else {
          const prompt = ['allowed', 'scope-error', 'wrong-project', 'no-workspace', 'no-agent'].find((key) => JSON.stringify(messages).includes('policy-' + key));
          const names = tools?.map(({ function: fn }) => fn?.name ?? '') ?? [];
          if (prompt) requests.set(prompt, names);
          if (brokered && names.includes(brokered)) return completion(model, toolCall(0, 'call_oauth', brokered, { value: 7 }), 'tool_calls');
        }
        return completion(model, [{ role: 'assistant', content: 'Synthetic OAuth reply' }], 'stop');
      },
    }, profile, definitions);
    adapter = await startAdapter(root, runtime, () => undefined);
  }

  await launch();
  const browser = page = await chromium(join(root, 'chromium-settings'));
  const consentBrowser = signInPage = await chromium(join(root, 'chromium-consent'));
  await consentBrowser.command('Security.setIgnoreCertificateErrors', { ignore: true });
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const click = (selector: string) => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function press(key: string, code: number) {
    for (const type of ['keyDown', 'keyUp']) await browser.command('Input.dispatchKeyEvent', { type, key,
      code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code, ...(type === 'keyDown' && key === ' ' && { text: ' ' }) });
  }
  await browser.command('Page.navigate', { url: adapter!.pairURL() });
  await browser.ready("!document.querySelector('#new-session')?.disabled && location.hash === ''");
  await click('#open-settings');
  let id = '';
  for (const [locale, signedOut, signedIn, login, logout] of [
    ['zh-TW', '未登入', '已登入', '登入', '登出'], ['en', 'Signed out', 'Signed in', 'Sign in', 'Sign out'],
  ] as const) {
    await selectLocale(browser, locale);
    await click('[data-section="mcp"]');
    await click('#settings-open-mcp');
    await browser.ready("document.querySelector('#mcp-import').checkVisibility()");
    if (!id) {
      await browser.evaluate("document.querySelector('#mcp-import').focus()");
      assert.equal(await browser.evaluate('document.activeElement.id'), 'mcp-import');
      await browser.evaluate("window.addEventListener('error', (event) => window.oauthUiError = event.message)");
      await press(' ', 32);
      await browser.ready("document.querySelector('#mcp-editor').open || window.oauthUiError");
      assert.equal(await browser.evaluate('window.oauthUiError ?? null'), null);
      assert.equal(await browser.evaluate('document.activeElement.name'), 'snippet');
      await browser.command('Input.insertText', { text: JSON.stringify({ mcp: { 'Synthetic Inbox': {
        type: 'remote', url: fixture.origin + '/mcp', oauth: { client_id: '{env:LOCAL_CLIENT_ID}',
          client_secret: '{env:LOCAL_CLIENT_SECRET}', scopes: ['messages.read'] },
      } } }) });
      await press('Tab', 9);
      assert.equal(await browser.evaluate('document.activeElement.id'), 'mcp-import-apply');
      await press(' ', 32);
      const imported = await browser.evaluate(`(() => {
        const form = document.querySelector('#mcp-form').elements;
        return [form.transport.value, form.authentication.value, form.oauthClient.value, form.oauthClientId.placeholder,
          form.oauthClientSecret.placeholder, form.oauthClientId.value, form.oauthClientSecret.value, form.oauthClientSecret.type,
          form.oauthScopes.value, form.snippet.value];
      })()`);
      assert.deepEqual(imported, ['remote', 'oauth', 'static', '{env:LOCAL_CLIENT_ID}', '{env:LOCAL_CLIENT_SECRET}', '', '', 'password', 'messages.read', '']);
      noSecrets(await browser.evaluate<string>('document.documentElement.outerHTML'));
      await browser.evaluate(`(() => {
        const fields = document.querySelector('#mcp-form').elements;
        fields.localService.checked = true;
        fields.oauthClientId.value = ${JSON.stringify(fixture.client.id)};
        fields.oauthClientSecret.value = ${JSON.stringify(fixture.client.secret)};
        document.querySelector('#mcp-projects [value=default]').checked = true;
      })()`);
      await click('#mcp-form [type=submit]');
      await browser.ready("!document.querySelector('#mcp-editor').open && document.querySelector('[data-mcp-oauth-action]')");
      id = await browser.evaluate<string>("document.querySelector('.mcp-card h4').id.replace('mcp-server-', '')");
    }
    await browser.ready(`document.querySelector('[data-mcp-oauth-action]')?.textContent === ${JSON.stringify(login)}`);
    assert.match(await browser.evaluate<string>("document.querySelector('.mcp-card').textContent"), new RegExp(signedOut));
    consent = undefined;
    await browser.evaluate("document.querySelector('[data-mcp-oauth-action]').focus()");
    await press(' ', 32);
    await until(async () => consent || undefined, 15_000);
    await browser.ready(`document.querySelector('[data-mcp-oauth-action]')?.textContent === ${JSON.stringify(locale === 'en' ? 'Cancel sign-in' : '取消登入')}`);
    await consentBrowser.command('Page.navigate', { url: (consent as unknown as URL).href });
    await consentBrowser.ready("document.body?.textContent.includes('Signed in. Return to OEP') && !location.search");
    await browser.ready(`document.querySelector('[data-mcp-oauth-action]')?.textContent === ${JSON.stringify(logout)}`);
    assert.match(await browser.evaluate<string>("document.querySelector('.mcp-card').textContent"), new RegExp(signedIn));
    assert.ok(await browser.evaluate<boolean>(`(() => {
      const card = document.querySelector('.mcp-card');
      return card.getBoundingClientRect().right <= 390 && card.querySelector('[data-mcp-oauth-action]').checkVisibility();
    })()`));
    await click('.mcp-card .settings-actions button:nth-child(4)');
    await browser.ready("document.querySelector('.mcp-result').textContent.includes('messages.read')");
    noSecrets(await browser.evaluate<string>('document.documentElement.outerHTML'));
    if (locale === 'zh-TW') {
      await browser.evaluate("document.querySelector('[data-mcp-oauth-action]').focus()");
      await press(' ', 32);
      await browser.ready(`document.querySelector('[data-mcp-oauth-action]')?.textContent === ${JSON.stringify(login)}`);
    }
  }
  const snapshot = await browser.evaluate<string>("import('/api.js').then(async ({ request }) => JSON.stringify(await request('/api/settings/mcp/custom')))");
  noSecrets(snapshot);
  const owned = JSON.parse(snapshot).servers[0];
  assert.equal(owned.oauthStatus.state, 'signed-in');
  await stopRuntime();
  const store = new WebStore(join(root, 'web.sqlite'));
  try {
    const server = store.customMcpServers().find((item) => item.id === id);
    assert.ok(server?.transport === 'remote');
    const publicDefinition = { ...server, localService: false, deniedTools: ['write_message'] };
    const storage = mcpOAuthStorage(root);
    const stored = storage.read(id) as object;
    storage.write(id, { ...stored, binding: oauthBinding(publicDefinition) });
    store.saveCustomMcp(publicDefinition);
  } finally { store.close(); }
  brokered = `${customMcpName(id)}_x_${createHash('sha256').update('messages.read').digest('hex').slice(0, 18)}`;
  await launch();
  assert.equal(runtime!.remoteMcp!.status.get(id), 'connected');
  const effectiveConfig = JSON.stringify(await runtime!.client.config.get({}));
  noSecrets(effectiveConfig);
  assert.ok(!effectiveConfig.includes(fixture.origin), 'OpenCode config contains only the local broker endpoint for this server');
  const pair = new URL(adapter!.pairURL());
  const paired = await fetch(pair.origin + '/api/pair', { method: 'POST', headers: { origin: pair.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: new URLSearchParams(pair.hash.slice(1)).get('pair') }) });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  const { csrf } = await paired.json();
  const post = (path: string, data: object) => fetch(pair.origin + path, { method: 'POST',
    headers: { cookie, origin: pair.origin, 'x-oep-csrf': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const before = fixture.callNames.length;
  using db = new DatabaseSync(join(root, 'web.sqlite'));
  for (const [policy, workspace, allowed] of [
    ['allowed', 'default', true], ['scope-error', 'default', true], ['wrong-project', 'secondary', false],
    ['no-workspace', 'default', false], ['no-agent', 'default', false],
  ] as const) {
    fixture.denyScope(policy === 'scope-error');
    if (policy === 'no-workspace') db.prepare('DELETE FROM workspace_mcp_grants WHERE server_id=?').run(id);
    if (policy === 'no-agent') {
      db.prepare("INSERT INTO workspace_mcp_grants VALUES ('legacy-default',?)").run(id);
      db.prepare("UPDATE agent_capabilities SET enabled=0 WHERE agent_id='main' AND capability_id=?").run(id);
    }
    const path = `/api/projects/${workspace}/sessions`;
    const created = await post(path, { agent: 'inspector' });
    assert.equal(created.status, 201);
    assert.equal((await post(`${path}/${(await created.json()).id}/turns`, {
      id: randomUUID(), text: `policy-${policy}`, attachments: [], workbook: false,
    })).status, 202);
    const names = await until(async () => requests.get(policy), 30_000);
    assert.equal(names.includes(brokered), allowed);
    assert.equal(names.filter((name) => name === readFileTool).length, 1);
    assert.ok(!names.some((name) => name.endsWith('_write_message')));
    if (allowed) await until(async () => (policy === 'scope-error' ? scopeError : toolResult) || undefined, 20_000);
  }
  assert.deepEqual(fixture.callNames.slice(before), ['messages.read', 'messages.read']);
  scan(root);
  console.log('Chromium OAuth verified in zh-TW and en at 390 px with keyboard and JSON import. Pinned OpenCode verified exact tool forwarding and agent/workspace grants.');
} finally {
  oauth.close();
  try { await stopRuntime(); }
  finally {
    try { await Promise.all([page?.close(), signInPage?.close()]); }
    finally { await fixture.close(); }
  }
}
