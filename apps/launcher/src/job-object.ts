import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atRepo } from './paths.ts';
import { until, waitForExit } from '../../../scripts/phase0/probe-http.ts';

export type JobStop = { supervisorExit: number | null; childExit: number | null; members: number; orphans: number | null };

export function startJob(control: string, workspace: string, env: NodeJS.ProcessEnv) {
  const powershell = process.env.OEP_PWSH || join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe');
  const processHandle = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', atRepo('scripts/windows/runtime-job.ps1')], {
    cwd: workspace, windowsHide: true, stdio: 'ignore',
    env: { ...env, OEP_JOB_NODE: process.execPath, OEP_JOB_CONTROL: control, OEP_JOB_OWNER: String(process.pid) },
  });
  let exited = false;
  const finished = new Promise<number | null>((resolve) => {
    processHandle.once('error', () => { exited = true; resolve(null); });
    processHandle.once('exit', (code) => { exited = true; resolve(code); });
  });
  const record = <T>(name: string) => {
    const path = join(control, `${name}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined;
  };
  return {
    alive: () => !exited,
    finished,
    ready: () => until(async () => {
      if (exited) throw new Error((await finished) === 23 ? 'Existing OEP launcher' : 'Job exited before readiness');
      return record<{ pid: number; members: number }>('job');
    }, 15_000),
    async stop(): Promise<JobStop> {
      if (!exited) {
        writeFileSync(join(control, 'stop'), '');
        await waitForExit(finished, 8_000);
      }
      if (!exited) processHandle.kill();
      const supervisorExit = await finished;
      const childExit = record<{ code: number | null }>('exit')?.code ?? null;
      const stopped = record<{ members: number; orphans: number }>('stopped');
      return { supervisorExit, childExit, members: stopped?.members ?? 0, orphans: stopped?.orphans ?? null };
    },
  };
}
