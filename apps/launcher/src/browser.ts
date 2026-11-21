import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { checkDirectory } from '../../adapter/src/runs/workspace.ts';

const requestName = /^open-[a-f\d-]{36}\.request$/;

export async function acquireBrowserLauncher(data: string) {
  const name = createHash('sha256').update(data.toLowerCase()).digest('hex').slice(0, 32);
  const pipe = `\\\\.\\pipe\\OEP.Web.${name}`;
  const lock = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(pipe, () => { lock.removeListener('error', reject); resolve(); });
    });
    return () => new Promise<void>((resolve) => lock.close(() => resolve()));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
    checkDirectory(data);
    writeFileSync(join(data, `open-${randomUUID()}.request`), '', { flag: 'wx' });
    return undefined;
  }
}

export function requestedReopen(data: string) {
  const requests = readdirSync(data, { withFileTypes: true }).filter((item) => item.isFile() && requestName.test(item.name));
  if (!requests.length) return false;
  checkDirectory(data);
  for (const request of requests) unlinkSync(join(data, request.name));
  return true;
}

export function openBrowser(url: string) {
  return new Promise<void>((resolve, reject) => {
    const system = process.env.SystemRoot!;
    const { USERPROFILE, LOCALAPPDATA, APPDATA, TEMP, TMP } = process.env;
    execFile(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath $env:OEP_BROWSER_URL -ErrorAction Stop",
    ], { windowsHide: true, timeout: 10_000,
      env: { SystemRoot: system, WINDIR: system, USERPROFILE, LOCALAPPDATA, APPDATA, TEMP, TMP, OEP_BROWSER_URL: url } },
    (error) => error ? reject(new Error('The default browser could not open OEP')) : resolve());
  });
}
