import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function physicalPath(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    return join(physicalPath(parent), basename(path));
  }
  return realpathSync.native(path);
}

function within(path: string, root: string) {
  if (process.platform === 'win32') {
    path = path.toLowerCase();
    root = root.toLowerCase();
  }
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep));
}

export function requireTestDataDir(env: NodeJS.ProcessEnv = process.env) {
  const data = env.OEP_DATA_DIR;
  const message = 'Tests require OEP_DATA_DIR to be an absolute path outside %LOCALAPPDATA%\\OEP.';
  if (!data || !isAbsolute(data)) throw new Error(message);
  const root = resolve(data);
  const live = resolve(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OEP');
  if (within(root, live)) throw new Error(message);
  let overlaps;
  try {
    overlaps = within(physicalPath(root), physicalPath(live));
  } catch {
    throw new Error(message + ' Could not resolve the data directory or its existing ancestors.');
  }
  if (overlaps) throw new Error(message);
  return root;
}
