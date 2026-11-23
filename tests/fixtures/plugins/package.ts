import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { sha256 } from '../../../apps/adapter/src/plugins/package.ts';

export const sampleDirectory = fileURLToPath(new URL('synthetic/', import.meta.url));
export const sampleID = 'oep.synthetic';
export const samplePage = 'oep.synthetic.page';

export function samplePlugin(options: { version?: string; range?: string; body?: string; dataRead?: boolean } = {}) {
  const root = join(sampleDirectory, 'payload');
  const entries: Record<string, Buffer> = {};
  for (const name of readdirSync(root)) entries['payload/' + name] = readFileSync(join(root, name));
  if (options.body) entries['payload/en.json'] = Buffer.from(JSON.stringify({ 'page.title': 'Synthetic builder', 'page.body': options.body }));
  const manifest = JSON.parse(readFileSync(join(sampleDirectory, 'manifest.json'), 'utf8'));
  if (options.version) manifest.version = options.version;
  if (options.range) manifest.oepCompatibility = options.range;
  if (options.dataRead) {
    manifest.permissions.operations.push('data.read');
    manifest.permissions.dataScope = 'plugin-workspace';
  }
  manifest.files = Object.entries(entries).map(([path, bytes]) => ({ path: path.slice(8), size: bytes.length, sha256: sha256(bytes) }));
  entries['manifest.json'] = Buffer.from(JSON.stringify(manifest));
  return Buffer.from(zipSync(entries, { level: 0, mtime: new Date(2000, 0, 1) }));
}
