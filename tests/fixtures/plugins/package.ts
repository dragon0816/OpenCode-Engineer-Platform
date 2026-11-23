import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { sha256 } from '../../../apps/adapter/src/plugins/package.ts';

export const sampleDirectory = fileURLToPath(new URL('synthetic/', import.meta.url));
export const sampleID = 'oep.synthetic';
export const samplePage = 'oep.synthetic.page';

export function samplePlugin(options: { version?: string; range?: string; body?: string; dataRead?: boolean;
  runtime?: boolean; timeoutMs?: number; dependency?: string; namespace?: string } = {}) {
  const root = join(sampleDirectory, 'payload');
  const entries: Record<string, Buffer> = {};
  for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(file.parentPath, file.name);
    entries['payload/' + relative(root, path).replaceAll('\\', '/')] = readFileSync(path);
  }
  const manifest = JSON.parse(readFileSync(join(sampleDirectory, 'manifest.json'), 'utf8'));
  if (options.version) manifest.version = options.version;
  if (options.range) manifest.oepCompatibility = options.range;
  if (options.runtime) {
    manifest.components.pythonWorkers[0].timeoutMs = options.timeoutMs ?? 30_000;
  } else {
    // Preserve the slice 1 fixtures used by admission and migration assertions.
    manifest.permissions = { ...manifest.permissions, operations: ['worker.run'], dataScope: 'none',
      modelBroker: 'none', sourceBroker: 'none' };
    for (const name of ['panels', 'reviewTypes', 'dataSchemas', 'collections']) manifest.components[name] = [];
    const page = JSON.parse(entries['payload/page.json'].toString());
    delete page.actions;
    entries['payload/page.json'] = Buffer.from(JSON.stringify(page));
  }
  if (options.dataRead && !options.runtime) {
    manifest.permissions.operations.push('data.read');
    manifest.permissions.dataScope = 'plugin-workspace';
  }
  for (const locale of ['en', 'zh-TW']) {
    const path = 'payload/' + locale + '.json';
    const messages = JSON.parse(entries[path].toString());
    if (!options.runtime) delete messages['page.run'];
    if (locale === 'en' && options.body) messages['page.body'] = options.body;
    entries[path] = Buffer.from(JSON.stringify(messages));
  }
  if (options.dependency) manifest.components.pythonWorkers[0].dependencies = [{
    distribution: options.dependency, module: options.dependency,
  }];
  if (options.namespace) {
    Object.assign(manifest, JSON.parse(JSON.stringify(manifest).replaceAll(sampleID, options.namespace)));
    for (const name of Object.keys(entries).filter((name) => name.endsWith('.json'))) {
      entries[name] = Buffer.from(entries[name].toString().replaceAll(sampleID, options.namespace));
    }
  }
  manifest.files = Object.entries(entries).map(([path, bytes]) => ({ path: path.slice(8), size: bytes.length, sha256: sha256(bytes) }));
  entries['manifest.json'] = Buffer.from(JSON.stringify(manifest));
  return Buffer.from(zipSync(entries, { level: 0, mtime: new Date(2000, 0, 1) }));
}
