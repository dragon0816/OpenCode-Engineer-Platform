import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { until, waitForExit } from '../../scripts/phase0/probe-http.ts';

const root = dataDirectory();
const preload = pathToFileURL(resolve('tests/e2e/launch-bridge.ts')).href;
const system = join(process.env.SystemRoot!, 'System32');
const syntheticURL = 'http://example.invalid/v1';
const start = (name: string, script = 'wscript') => {
  const data = join(root, name);
  mkdirSync(data, { recursive: true });
  const exe = script === 'wscript' ? join(system, 'wscript.exe') :
    join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = script === 'wscript' ? ['//B', resolve('scripts/windows/Start-OEP.vbs')] :
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', resolve('scripts/windows/Start-OEP.ps1')];
  const wrapper = spawn(exe, args, {
    windowsHide: true, env: { ...process.env, OEP_DATA_DIR: data, NODE_OPTIONS: `--import=${preload}`,
      OEP_LITELLM_BASE_URL: syntheticURL, OEP_LITELLM_API_KEY: randomUUID(),
      OEP_MODEL_ALIAS: 'gpt-5.4-mini' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const ended = new Promise<number | null>((resolve) => wrapper.once('exit', resolve));
  return { data, wrapper, ended };
};
const opened = (data: string) => {
  const path = join(data, 'browser.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) =>
    JSON.parse(line) as { pid: number; origin: string }) : [];
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};
function jobRecords(data: string) {
  const web = join(data, 'web');
  return readdirSync(web).filter((name) => name.startsWith('launch-')).flatMap((launch) =>
    readdirSync(join(web, launch)).filter((name) => name.startsWith('server-')).map((server) =>
      JSON.parse(readFileSync(join(web, launch, server, 'job.json'), 'utf8')) as { memberPIDs: number[]; supervisorPID: number }));
}
async function orphanTime(pids: number[], started: number) {
  await until(async () => pids.every((pid) => !alive(pid)) || undefined, 10_000);
  const elapsed = Math.round(performance.now() - started);
  assert.ok(elapsed < 10_000);
  return elapsed;
}
async function firstOpen(instance: ReturnType<typeof start>) {
  await until(async () => {
    if (instance.wrapper.exitCode !== null) throw new Error('Windows launcher exited before the browser handoff');
    return opened(instance.data).length === 1 || undefined;
  }, 90_000);
}
const name = 'Windows 啟動 測試';
const primary = start(name);
try {
  await firstOpen(primary);
  const secondary = start(name);
  try { assert.equal(await waitForExit(secondary.ended, 10_000), 0); }
  finally { if (secondary.wrapper.exitCode === null) secondary.wrapper.kill(); }
  await until(async () => opened(primary.data).length === 2 || undefined, 5_000);
  const records = opened(primary.data);
  assert.deepEqual(records[0], records[1]);
  assert.ok(alive(records[0].pid));
  assert.equal(jobRecords(primary.data).length, 1);
  const { memberPIDs, supervisorPID } = jobRecords(primary.data)[0];
  assert.ok(memberPIDs.length >= 2 && memberPIDs.every(alive));
  const started = performance.now();
  writeFileSync(join(primary.data, 'stop-test'), '', { flag: 'wx' });
  assert.equal(await waitForExit(primary.ended, 15_000), 0);
  console.log(JSON.stringify({ launch: 'normal', browserRequests: records.length, supervisors: 1, members: memberPIDs.length,
    orphanElapsedMs: await orphanTime([...memberPIDs, supervisorPID], started), orphans: 0, data: primary.data }));
} finally { if (primary.wrapper.exitCode === null) primary.wrapper.kill(); }

const forced = start('Windows 強制停止', 'powershell');
try {
  await firstOpen(forced);
  const { memberPIDs, supervisorPID: jobSupervisorPID } = jobRecords(forced.data)[0];
  assert.ok(memberPIDs.every(alive));
  const supervisorPID = opened(forced.data)[0].pid;
  assert.ok(alive(supervisorPID));
  const started = performance.now();
  assert.equal(process.kill(supervisorPID, 'SIGKILL'), true);
  await waitForExit(forced.ended, 5_000);
  console.log(JSON.stringify({ launch: 'forced', members: memberPIDs.length,
    orphanElapsedMs: await orphanTime([...memberPIDs, jobSupervisorPID], started), orphans: 0, data: forced.data }));
} finally { if (forced.wrapper.exitCode === null) forced.wrapper.kill(); }
