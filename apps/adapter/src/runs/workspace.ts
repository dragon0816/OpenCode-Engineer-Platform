import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atRepo } from '../../../launcher/src/paths.ts';
import type { FileIdentity } from '../../../../packages/contracts/src/run.ts';

export type OpenFile = { identity: FileIdentity; data: Buffer };

export class WorkspacePathError extends Error {
  constructor(message = 'Workspace file is missing, unsafe, or changed') { super(message); }
}

const unsafe = () => new WorkspacePathError();
const relativeName = /^[a-z\d][a-z\d._-]*(?:\/[a-z\d][a-z\d._-]*)*$/i;
const pythonPayloadName = /^[a-z\d_][a-z\d._-]*(?:\/[a-z\d_][a-z\d._-]*)*$/i;

export function scopedPath(root: string, name: string, kind: 'workspace' | 'python-payload' = 'workspace') {
  const allowed = kind === 'python-payload' ? pythonPayloadName : relativeName;
  if (!allowed.test(name) || name.split('/').some((part) =>
    part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw unsafe();
  const path = join(root, ...name.split('/'));
  const location = relative(root, path);
  if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) throw unsafe();
  return path;
}

function windowsAttributes(path: string, mode?: 'expand' | 'plain') {
  if (process.platform !== 'win32') return path;
  // libuv recognises symlinks and junctions. Check the Windows attribute for other reparse tags too.
  const worker = atRepo('workers/files/windows_probe.py');
  const probe = (timeout: number) => spawnSync(process.env.OEP_PYTHON || 'python', ['-I', '-B', worker, path, ...(mode ? [mode] : [])], {
    windowsHide: true, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
  });
  let result = probe(2_000);
  // Windows can delay a cold Python launch. Retry the same check only after a timeout.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') result = probe(5_000);
  if (result.status !== 0 || mode === 'expand' && !result.stdout) throw unsafe();
  return result.stdout && normalized(result.stdout) !== normalized(path) ? result.stdout : path;
}

const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

function inspectPath(full: string, directory: boolean, expected = full) {
  const ancestors: string[] = [];
  for (let ancestor = dirname(full); ; ancestor = dirname(ancestor)) {
    ancestors.unshift(ancestor);
    if (dirname(ancestor) === ancestor) break;
  }
  for (const ancestor of ancestors) if (!lstatSync(ancestor).isDirectory()) throw unsafe();
  const file = lstatSync(full, { bigint: true });
  if (directory ? !file.isDirectory() : !file.isFile() || file.nlink !== 1n) throw unsafe();
  if (normalized(realpathSync.native(full)) !== normalized(expected)) throw unsafe();
  return file;
}

export function checkDirectory(path: string, plain = false) {
  const full = resolve(path);
  windowsAttributes(full, plain ? 'plain' : undefined);
  return inspectPath(full, true);
}

// Data roots can arrive in DOS 8.3 form. Expand the name independently of realpath's link resolution.
export function canonicalWorkspaceDirectory(path: string) {
  const full = resolve(path);
  const expected = windowsAttributes(full, 'expand');
  inspectPath(full, true, expected);
  return expected;
}

const metadata = (file: BigIntStats) => ({
  device: String(file.dev), inode: String(file.ino), created: String(file.birthtimeNs),
  modified: String(file.mtimeNs), changed: String(file.ctimeNs), bytes: Number(file.size),
});
const same = (a: ReturnType<typeof metadata>, b: ReturnType<typeof metadata>) =>
  a.device === b.device && a.inode === b.inode && a.created === b.created && a.modified === b.modified &&
  a.changed === b.changed && a.bytes === b.bytes;

export function openWorkspaceFile(root: string, name: string, maximum: number, expected?: FileIdentity,
  plain: boolean | 'python-payload' = false): OpenFile {
  const path = resolve(scopedPath(root, name, plain === 'python-payload' ? plain : undefined));
  windowsAttributes(path, plain === true ? 'plain' : undefined);
  const before = metadata(inspectPath(path, false));
  if (before.bytes > maximum || expected && !same(before, expected)) throw unsafe();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const verify = () => {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !same(before, metadata(opened)) ||
          !same(before, metadata(inspectPath(path, false)))) throw unsafe();
    };
    verify();
    const data = Buffer.alloc(before.bytes);
    let offset = 0;
    while (offset < data.length) {
      const length = readSync(fd, data, offset, data.length - offset, offset);
      if (!length) throw unsafe();
      offset += length;
    }
    verify();
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (expected && sha256 !== expected.sha256) throw unsafe();
    return { data, identity: { ...before, sha256 } };
  } finally { closeSync(fd); }
}
