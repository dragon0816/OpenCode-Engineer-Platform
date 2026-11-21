import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileIdentity } from '../../../../packages/contracts/src/run.ts';

export type OpenFile = { identity: FileIdentity; data: Buffer };

const unsafe = () => new Error('Workspace file is missing, unsafe, or changed');
const relativeName = /^[a-z\d][a-z\d._-]*(?:\/[a-z\d][a-z\d._-]*)*$/i;

export function scopedPath(root: string, name: string) {
  if (!relativeName.test(name) || name.split('/').some((part) =>
    part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw unsafe();
  const path = join(root, ...name.split('/'));
  const location = relative(root, path);
  if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) throw unsafe();
  return path;
}

function windowsAttributes(path: string) {
  if (process.platform !== 'win32') return;
  // libuv recognises symlinks and junctions. Check the Windows attribute for other reparse tags too.
  const result = spawnSync(process.env.OEP_PYTHON || 'python', ['-I', '-c', [
    'import ctypes, os, sys',
    'attributes = ctypes.windll.kernel32.GetFileAttributesW',
    'attributes.argtypes = [ctypes.c_wchar_p]',
    'attributes.restype = ctypes.c_uint32',
    'p = sys.argv[1]',
    'parents = [p]',
    'while True:',
    ' parent = os.path.dirname(p)',
    ' if parent == p: break',
    ' parents.append(parent)',
    ' p = parent',
    'for p in reversed(parents):',
    ' result = attributes(p)',
    ' if result == 0xffffffff or result & 0x400: sys.exit(1)',
  ].join('\n'), path], { windowsHide: true, timeout: 2_000, stdio: 'ignore' });
  if (result.status !== 0) throw unsafe();
}

const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

function inspectPath(path: string, directory: boolean, attributes: boolean) {
  const full = resolve(path);
  const ancestors: string[] = [];
  for (let ancestor = dirname(full); ; ancestor = dirname(ancestor)) {
    ancestors.unshift(ancestor);
    if (dirname(ancestor) === ancestor) break;
  }
  if (attributes) windowsAttributes(full);
  for (const ancestor of ancestors) if (!lstatSync(ancestor).isDirectory()) throw unsafe();
  const file = lstatSync(full, { bigint: true });
  if (directory ? !file.isDirectory() : !file.isFile() || file.nlink !== 1n) throw unsafe();
  if (normalized(realpathSync.native(full)) !== normalized(full)) throw unsafe();
  return file;
}

export const checkDirectory = (path: string) => { inspectPath(path, true, true); };
const metadata = (file: BigIntStats) => ({
  device: String(file.dev), inode: String(file.ino), created: String(file.birthtimeNs),
  modified: String(file.mtimeNs), changed: String(file.ctimeNs), bytes: Number(file.size),
});
const same = (a: ReturnType<typeof metadata>, b: ReturnType<typeof metadata>) =>
  a.device === b.device && a.inode === b.inode && a.created === b.created && a.modified === b.modified &&
  a.changed === b.changed && a.bytes === b.bytes;

export function openWorkspaceFile(root: string, name: string, maximum: number, expected?: FileIdentity): OpenFile {
  const path = scopedPath(root, name);
  const before = metadata(inspectPath(path, false, true));
  if (before.bytes > maximum || expected && !same(before, expected)) throw unsafe();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const verify = () => {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !same(before, metadata(opened)) ||
          !same(before, metadata(inspectPath(path, false, false)))) throw unsafe();
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
