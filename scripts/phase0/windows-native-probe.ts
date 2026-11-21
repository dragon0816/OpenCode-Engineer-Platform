import { OpenCode } from '@opencode/client';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { startModelProbe } from './model-probe.ts';
import { check } from './probe-assertions.ts';
import { retryReadiness, sse, until, waitForExit } from './probe-http.ts';
import { ownerCheckedFetch, ownsWindowsPeer } from './probe-listeners.ts';

const providerID = 'phase-zero-native';
const report = (evidence: object) => console.log(JSON.stringify({ test: 'O-3a-native', ...evidence }));
const options = () => ({ signal: AbortSignal.timeout(6000) });

async function freeLoopbackPort() {
  const socket = createServer();
  await new Promise<void>((done, reject) => socket.once('error', reject).listen(0, '127.0.0.1', done));
  const { port } = socket.address() as AddressInfo;
  await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}

function windowsListeners(rows: string, pid: number) {
  return rows.split(/\r?\n/).map((row) => row.trim().split(/\s+/))
    .filter(([protocol, , , state, owner]) => protocol === 'TCP' && state === 'LISTENING' && Number(owner) === pid)
    .map(([, local]) => local);
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Expected Windows x64');
  const executable = resolve('.phase0/assets/unpacked/opencode.exe');
  const pin = JSON.parse(readFileSync('config/opencode.pin.json', 'utf8')).windowsX64.binarySha256;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  if (hash.digest('hex') !== pin) throw new Error('Windows pin mismatch');

  mkdirSync('.phase0', { recursive: true });
  const root = mkdtempSync(resolve('.phase0', 'native-win-'));
  const workspace = join(root, 'workspace');
  const folder = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
  mkdirSync(workspace);
  const port = await freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const password = randomBytes(32).toString('hex');
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const system = process.env.SystemRoot!;
  const netstat = join(system, 'System32', 'netstat.exe');
  const powershell = join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe');
  const probe = await startModelProbe();
  const config = {
    update: 'disable', share: 'disabled', permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: providerID, effect: 'allow' }],
    providers: { [providerID]: { package: '@opencode/ai/providers/openai-compatible', name: 'Synthetic native',
      settings: { baseURL: `${probe.endpoint.url}/v1`, apiKey: probe.apiKey },
      models: { 'probe-model': { modelID: 'probe-model', capabilities: { tools: false, input: ['text'], output: ['text'] }, limit: { context: 32000, output: 256 } } },
    } },
  };
  const temp = folder('temp');
  const supervisor = spawn(powershell, ['-NoProfile', '-File', resolve('scripts/phase0/windows-opencode-job.ps1')], {
    cwd: workspace, windowsHide: true, stdio: 'ignore', env: {
      SystemRoot: system, WINDIR: system, SystemDrive: process.env.SystemDrive, COMSPEC: join(system, 'System32', 'cmd.exe'),
      PATH: [dirname(process.execPath), join(system, 'System32'), system].join(delimiter),
      HOME: root, USERPROFILE: root, APPDATA: folder('roaming'), LOCALAPPDATA: folder('local'), TEMP: temp, TMP: temp,
      XDG_CONFIG_HOME: folder('config'), XDG_DATA_HOME: folder('data'), XDG_CACHE_HOME: folder('cache'), XDG_STATE_HOME: folder('state'),
      OPENCODE_TEST_HOME: root, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_FLAGS: '-automations',
      OEP_P0_EXE: executable, OEP_P0_PORT: String(port), OEP_P0_CONTROL: root, OEP_P0_WORKSPACE: workspace, OEP_P0_NODE: process.execPath,
    },
  });
  const finished = new Promise<number | null>((done) => { supervisor.once('error', () => done(null)); supervisor.once('exit', done); });
  let stage = 'job-membership';
  try {
    const info = join(root, 'job.json');
    const job = await until(async () => {
      if (existsSync(info)) return JSON.parse(readFileSync(info, 'utf8')) as { pid: number; members: number };
      if (supervisor.exitCode !== null) throw new Error('Supervisor exited before readiness');
      return undefined;
    });
    check('native membership', { child: Number.isSafeInteger(job.pid) && job.pid > 0, members: job.members >= 2 });
    stage = 'authenticated-readiness';
    const tcpTable = () => execFileSync(netstat, ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const listeners = () => windowsListeners(tcpTable(), job.pid);
    const ownership = () => {
      const opened = listeners();
      return opened.length === 1 && opened[0] === `127.0.0.1:${port}`;
    };
    const guarded = ownerCheckedFetch(url, ownership, (peer) => supervisor.exitCode === null && ownsWindowsPeer(tcpTable(), job.pid, peer));
    const client = OpenCode.make({ baseUrl: url, fetch: guarded, headers: { authorization: auth } });
    const version = await until(async () => {
      if (supervisor.exitCode !== null) throw new Error('Supervisor stopped during readiness');
      try {
        const result = await client.server.info(options());
        await client.session.active(options());
        return result.version;
      } catch (error) { return retryReadiness(error); }
    });
    const unauthorized = await guarded(`${url}/api/info`, options());
    await unauthorized.body?.cancel();
    check('native readiness', { pin: version === '2.3.2', unauthorized: unauthorized.status === 401, ownership: ownership() });

    stage = 'session-and-sse';
    const { id } = await client.session.create({ title: 'Synthetic native', location: { directory: workspace },
      model: { id: 'probe-model', providerID } }, options());
    const eventsSignal = new AbortController();
    const connected = Promise.withResolvers<void>();
    // The event task may reject readiness before the caller starts to await it.
    void connected.promise.catch(() => undefined);
    const events = (async () => {
      const response = await guarded(`${url}/api/event`, { headers: { authorization: auth }, signal: AbortSignal.any([eventsSignal.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok || !response.body) throw new Error('Native event connection failed');
      let started = false;
      for await (const event of sse(response.body)) {
        const value = JSON.parse(event) as { type: string; data?: { sessionID?: string } };
        if (value.type === 'server.connected') connected.resolve();
        if (value.data?.sessionID !== id) continue;
        if (value.type === 'session.execution.started') started = true;
        if (value.type === 'session.execution.succeeded') return started;
      }
      throw new Error('Native SSE incomplete');
    })();
    void events.catch(connected.reject);
    try {
      await connected.promise;
      const admitted = await client.session.prompt({ sessionID: id, text: 'Synthetic native readiness only.' }, options());
      const ordered = await events;
      const messages = await client.message.list({ sessionID: id, type: 'assistant' }, options());
      const text = messages.data.flatMap((message) => message.type === 'assistant' ? message.content : [])
        .filter((part) => part.type === 'text').map((part) => part.text).join('');
      check('native session', { created: !!id, admitted: !!admitted.id, ordered, text: text === 'READY-P0',
        relay: probe.traces.length === 1 && probe.traces[0].model === 'probe-model' && probe.traces[0].status === 200 });
    } finally { eventsSignal.abort(); }

    const opened = listeners();
    check('native listeners', { onlyExpected: ownership() });
    stage = 'graceful-stop';
    writeFileSync(join(root, 'stop'), '', { flag: 'wx' });
    const code = await waitForExit(finished, 12000);
    const stopped = JSON.parse(readFileSync(join(root, 'stopped.json'), 'utf8'));
    const exited = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'));
    check('native stop', { supervisor: code === 0, child: exited.code === 0 && exited.requested,
      allMembers: stopped.members === job.members && stopped.orphan === 0, noListener: listeners().length === 0 });
    report({ ok: true, version, unauthenticated: unauthorized.status, prompt: true, sse: true,
      ipv4Listeners: opened.filter((address) => !address.startsWith('[')).length, ipv6Listeners: opened.filter((address) => address.startsWith('[')).length,
      jobMembers: job.members, childExit: exited.code, supervisorExit: code, orphans: stopped.orphan });
  } catch {
    report({ ok: false, stage });
    process.exitCode = 1;
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill();
      await finished;
    }
    probe.close();
  }
}

main().catch(() => { report({ ok: false, stage: 'setup' }); process.exitCode = 1; });
