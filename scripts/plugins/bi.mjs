import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packPlugin } from './package.mjs';

export const biArtifact = 'plugins/BI-Knowledge.oepplugin';
const pluginSource = fileURLToPath(new URL('../../plugins/bi-knowledge/', import.meta.url));
export const packBiPlugin = () => packPlugin(pluginSource);

export function writeBiPlugin(output, bytes) {
  const target = resolve(output, biArtifact);
  mkdirSync(dirname(target), { recursive: true });
  const staging = target + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(staging, bytes, { flag: 'wx' });
    renameSync(staging, target);
  } finally { rmSync(staging, { force: true }); }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { bytes, digest } = packBiPlugin();
  const target = writeBiPlugin(join(pluginSource, '..', '..', 'dist'), bytes);
  console.log(target + '\nSHA-256 ' + digest);
}
