import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const repo = resolve(process.env.OEP_REPO_ROOT ?? process.cwd());
export const atRepo = (...parts: string[]) => join(repo, ...parts);

export function dataDirectory() {
  const root = process.env.OEP_DATA_DIR || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'OEP'));
  if (!root || !isAbsolute(root)) throw new Error('OEP data directory must be absolute');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'phase1-'));
}

export async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
