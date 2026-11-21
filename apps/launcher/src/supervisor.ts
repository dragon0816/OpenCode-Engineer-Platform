import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { knowledgeMcpName, knowledgeToolName } from '../../adapter/src/opencode/knowledge-mcp.ts';
import type { startKnowledgeMcp } from '../../adapter/src/opencode/knowledge-mcp.ts';
import { delimiter, dirname, join } from 'node:path';
import { openCodeEndpoint } from '../../adapter/src/opencode/client.ts';
import { providerID } from '../../adapter/src/opencode/gateway.ts';
import { atRepo, sha256 } from './paths.ts';
import { startJob } from './job-object.ts';
import { pause, retryReadiness, until } from '../../../scripts/phase0/probe-http.ts';

const pin = () => JSON.parse(readFileSync(atRepo('config/opencode.pin.json'), 'utf8'));
export type Supervisor = Awaited<ReturnType<typeof supervise>>;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = socket.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

type KnowledgeMcp = Awaited<ReturnType<typeof startKnowledgeMcp>>['config'];

function config(relay: { baseURL: string; key: string }, alias: string, web: boolean, knowledge?: KnowledgeMcp) {
  const template = JSON.parse(readFileSync(atRepo('config/opencode.example.jsonc'), 'utf8'));
  const provider = template.providers[providerID];
  provider.settings = { baseURL: relay.baseURL, apiKey: relay.key };
  provider.models[alias] = {
    modelID: alias, capabilities: { tools: true, input: ['text', 'image', 'pdf'], output: ['text'] },
    limit: { context: 32_000, output: 2048 },
  };
  if (web) {
    template.agents.inspector.system = 'Answer the user using the supplied content. Explain when a document cannot be read. You are a read-only analysis assistant.';
    template.agents.workbook.system = 'Answer the user using the supplied content. Prepare workbook data only when the server gives a workbook output instruction.';
  }
  if (knowledge) {
    template.mcp = { servers: { [knowledgeMcpName]: knowledge } };
    template.permissions.push({ action: `${knowledgeMcpName}_${knowledgeToolName}`, resource: '*', effect: 'allow' });
  }
  return JSON.stringify(template);
}

export async function supervise(root: string, relay: { baseURL: string; key: string }, alias: string, profile?: string,
  knowledge?: KnowledgeMcp, isolatedJob = false) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
    throw new Error('OEP runtime requires Windows x64 and Node.js 24');
  }
  const expected = pin();
  const exe = atRepo('.phase0/assets/unpacked/opencode.exe');
  const installed = JSON.parse(readFileSync(atRepo('node_modules/@opencode/client/package.json'), 'utf8'));
  const locked = JSON.parse(readFileSync(atRepo('package-lock.json'), 'utf8')).packages['node_modules/@opencode/client'];
  if (await sha256(exe) !== expected.windowsX64.binarySha256 ||
      await sha256(atRepo('.phase0/source/openapi.json')) !== expected.openapi.sha256 ||
      installed.version !== expected.client.version || locked.integrity !== expected.client.integrity ||
      locked.version !== expected.client.version) throw new Error('OpenCode pin verification failed');
  const system = process.env.SystemRoot!;
  const baseEnv = { SystemRoot: system, WINDIR: system, SystemDrive: process.env.SystemDrive,
    COMSPEC: join(system, 'System32', 'cmd.exe'), PATH: [dirname(process.execPath), join(system, 'System32'), system].join(delimiter) };
  const version = execFileSync(exe, ['--version'], {
    encoding: 'utf8', env: baseEnv, windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().replace(/^opencode v?/, '');
  if (`v${version}` !== expected.tag) throw new Error('OpenCode executable version mismatch');

  const testScope = isolatedJob ? randomBytes(16).toString('hex') : undefined;
  async function launch() {
    const control = mkdtempSync(join(root, 'server-'));
    const folder = (name: string) => { const path = join(control, name); mkdirSync(path); return path; };
    const persistent = (name: string) => {
      if (!profile) return folder(name);
      const path = join(profile, name);
      mkdirSync(path, { recursive: true });
      return path;
    };
    const temp = folder('temp');
    const workspace = folder('workspace');
    const password = randomBytes(32).toString('hex');
    const port = await freePort();
    const job = startJob(control, workspace, {
      ...baseEnv, HOME: profile ?? control, USERPROFILE: profile ?? control, APPDATA: persistent('roaming'), LOCALAPPDATA: persistent('local'), TEMP: temp, TMP: temp,
      XDG_CONFIG_HOME: persistent('config'), XDG_DATA_HOME: persistent('data'), XDG_CACHE_HOME: persistent('cache'), XDG_STATE_HOME: persistent('state'),
      OPENCODE_TEST_HOME: profile ?? control, OPENCODE_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: config(relay, alias, Boolean(profile), knowledge),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_FLAGS: '-automations',
      OEP_JOB_EXE: exe, OEP_JOB_PORT: String(port), ...(testScope && { OEP_JOB_TEST_SCOPE: testScope }),
    });
    try {
      const { pid, members } = await job.ready();
      const endpoint = openCodeEndpoint(port, pid, password, job.alive);
      const info = await until(async (signal) => {
        if (!job.alive()) throw new Error('Job exited during readiness');
        try {
          const result = await endpoint.client.server.info({ signal });
          await endpoint.client.session.active({ signal });
          return result;
        } catch (error) { return retryReadiness(error); }
      });
      const unauthorized = await endpoint.request('/api/info', AbortSignal.timeout(5_000), false);
      await unauthorized.body?.cancel();
      if (info.version !== version || unauthorized.status !== 401) throw new Error('Authenticated readiness mismatch');
      return { endpoint, control, version, pid, members, unauthorized: unauthorized.status, stop: job.stop, finished: job.finished };
    } catch (error) {
      const stopped = await job.stop();
      if (stopped.supervisorExit === 23) throw new Error('Existing OEP launcher');
      throw error;
    }
  }

  try { return await launch(); }
  catch (error) {
    if (error instanceof Error && error.message === 'Existing OEP launcher') throw error;
    await pause(500);
    return launch();
  }
}
