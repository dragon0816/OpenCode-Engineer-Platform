import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atRepo } from '../../../launcher/src/paths.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';

export type OutputDirectory = { root: string; inode: string };
const filesWorker = () => atRepo('workers/files/windows_write.py');
const unavailable = () => new Error('Workspace output is unavailable');
const outputName = /^[a-z\d][a-z\d._-]{0,119}$/;

function runWorker(operation: 'mkdir' | 'write' | 'copy' | 'external-mkdir' | 'external-copy', folder: OutputDirectory, name: string, data?: Buffer) {
  const key = operation.startsWith('external-') ? name.toLowerCase() : name;
  if (process.platform !== 'win32' || !outputName.test(key) || key.startsWith('staging-')) throw unavailable();
  scopedPath(folder.root, name);
  const processResult = spawnSync(process.env.OEP_PYTHON || 'python',
    ['-I', filesWorker(), operation, folder.root, name, folder.inode], {
      input: data, encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 4096,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
    });
  if (processResult.status !== 0) throw unavailable();
  return JSON.parse(processResult.stdout) as { inode: string; sha256?: string };
}

export function createWorkspaceOutput(parent: string, name: string, external = false) {
  const root = scopedPath(parent, name);
  const { inode } = runWorker(external ? 'external-mkdir' : 'mkdir', { root: parent, inode: String(checkDirectory(parent).ino) }, name);
  return { root, inode };
}

export function writeWorkspaceFile(folder: OutputDirectory, name: string, data: Buffer, maximum: number,
  operation: 'write' | 'copy' | 'external-copy' = 'write') {
  if (data.length > maximum) throw unavailable();
  const result = runWorker(operation, folder, name, data);
  const { identity } = openWorkspaceFile(folder.root, name, maximum);
  const hash = createHash('sha256').update(data).digest('hex');
  if (String(checkDirectory(folder.root).ino) !== folder.inode || identity.inode !== result.inode ||
      identity.sha256 !== result.sha256 || identity.sha256 !== hash) throw unavailable();
  return identity;
}
