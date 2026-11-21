import { spawnSync } from 'node:child_process';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { isLocalAbsoluteFolder } from '../../../../packages/knowledge/src/repository-files.ts';
import { HttpError } from '../http/errors.ts';
import { checkDirectory } from './workspace.ts';

const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
};

export function foldersOverlap(left: string, right: string) {
  return inside(left, right) || inside(right, left);
}

export function validateProjectFolder(path: unknown, dataRoot: string) {
  if (typeof path !== 'string' || !isLocalAbsoluteFolder(path)) {
    throw new HttpError(400, '請輸入本機資料夾的絕對路徑。');
  }
  const folder = resolve(path);
  const protectedRoots = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    : ['/bin', '/boot', '/dev', '/etc', '/lib', '/proc', '/run', '/sbin', '/sys', '/usr', '/var'];
  if (folder === parse(folder).root || [dataRoot, ...protectedRoots].some((root) => root && foldersOverlap(resolve(root), folder))) {
    throw new HttpError(400, '無法加入系統或 OEP 管理的資料夾。');
  }
  if (process.platform === 'win32') {
    const volume = parse(folder).root;
    const result = spawnSync(process.env.OEP_PYTHON || 'python', ['-I', '-c',
      'import ctypes, sys; sys.exit(0 if ctypes.windll.kernel32.GetDriveTypeW(sys.argv[1]) in (2, 3) else 1)', volume],
    { windowsHide: true, timeout: 2000, stdio: 'ignore' });
    if (result.status !== 0) throw new HttpError(400, '請使用本機磁碟上的資料夾。');
  }
  try { checkDirectory(folder); }
  catch { throw new HttpError(400, '找不到可用的資料夾，或路徑包含連結。'); }
  return folder;
}
