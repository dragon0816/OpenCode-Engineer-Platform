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

function windowsAttributes(path: string, expandShortNames = false) {
  if (process.platform !== 'win32') return path;
  // libuv recognises symlinks and junctions. Check the Windows attribute for other reparse tags too.
  const result = spawnSync(process.env.OEP_PYTHON || 'python', ['-I', '-c', [
    'import ctypes, os, sys',
    'attributes = ctypes.windll.kernel32.GetFileAttributesW',
    'attributes.argtypes = [ctypes.c_wchar_p]',
    'attributes.restype = ctypes.c_uint32',
    'path = p = sys.argv[1]',
    'parents = [p]',
    'while True:',
    ' parent = os.path.dirname(p)',
    ' if parent == p: break',
    ' parents.append(parent)',
    ' p = parent',
    // Namespace each complete path after walking the normal drive or UNC ancestry.
    'slash = chr(92)',
    'prefix = slash * 2 + "?" + slash',
    'unc = prefix + "UNC" + slash',
    'def namespaced(p): return unc + p[2:] if p.startswith(slash * 2) else prefix + p',
    'for p in reversed(parents):',
    ' result = attributes(namespaced(p))',
    ' if result == 0xffffffff or result & 0x400: sys.exit(1)',
    'if len(sys.argv) > 2:',
    ' long_name = ctypes.windll.kernel32.GetLongPathNameW',
    ' long_name.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]',
    ' long_name.restype = ctypes.c_uint32',
    ' buffer = ctypes.create_unicode_buffer(32768)',
    ' if not 0 < long_name(namespaced(path), buffer, len(buffer)) < len(buffer): sys.exit(1)',
    ' name = buffer.value',
    ' sys.stdout.buffer.write((slash * 2 + name[len(unc):] if name.startswith(unc) else name.removeprefix(prefix)).encode("utf-8"))',
  ].join('\n'), path, ...(expandShortNames ? ['expand'] : [])], {
    windowsHide: true, timeout: 2_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH } });
  if (result.status !== 0 || expandShortNames && !result.stdout) throw unsafe();
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

export function checkDirectory(path: string) {
  const full = resolve(path);
  windowsAttributes(full);
  return inspectPath(full, true);
}

// Data roots can arrive in DOS 8.3 form. Expand the name independently of realpath's link resolution.
export function canonicalWorkspaceDirectory(path: string) {
  const full = resolve(path);
  const expected = windowsAttributes(full, true);
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

export function openWorkspaceFile(root: string, name: string, maximum: number, expected?: FileIdentity): OpenFile {
  const path = resolve(scopedPath(root, name));
  windowsAttributes(path);
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
