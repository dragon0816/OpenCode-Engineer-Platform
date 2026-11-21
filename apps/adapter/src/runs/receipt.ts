import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileDigest, Receipt } from '../../../../packages/contracts/src/run.ts';

export function localFile(workspace: string, name: 'program.js' | 'output.xlsx', maxBytes: number) {
  const path = join(workspace, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== join(realpathSync(workspace), name) ||
      stat.size > maxBytes) throw new Error('Unexpected workspace file');
  const data = readFileSync(path);
  const file: FileDigest = { path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  return { file, data, stat };
}

export function executeWorkbook(runID: string, workspace: string, program: ReturnType<typeof localFile>,
  redact: (value: string) => string): Promise<Receipt> {
  const startedAt = Date.now();
  const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './program-worker.ts' : './program-worker.js', import.meta.url));
  const child = spawn(process.execPath, ['--max-old-space-size=96', worker], {
    cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
  });
  let stdout = '';
  let stderr = '';
  let error: string | undefined;
  const deadline = setTimeout(() => { error = 'Program timed out'; child.kill(); }, 5_000);
  child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout = (stdout + value).slice(0, 8192); });
  child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr = (stderr + value).slice(0, 8192); });
  child.once('error', () => { error ??= 'Program spawn failed'; });
  child.stdin.on('error', () => { error ??= 'Program input failed'; });
  child.stdin.end(program.data);
  return new Promise((resolve) => child.once('close', (exitCode, signal) => {
    clearTimeout(deadline);
    resolve({ runID, programSha256: program.file.sha256, startedAt, finishedAt: Date.now(),
      exitCode, signal, stdout: redact(stdout), stderr: redact(stderr), error });
  }));
}
