import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { strictJSON, verifyPackage } from '../../apps/adapter/src/plugins/package.ts';
import { archiveLimit, entryLimit, fileLimit, manifestLimit, payloadPath } from '../../apps/adapter/src/plugins/zip.ts';
import { checkDirectory, openWorkspaceFile } from '../../apps/adapter/src/runs/workspace.ts';

function main(args) {
  const [input, output] = args;
  const root = resolve(input);
  checkDirectory(root);
  const manifest = strictJSON(openWorkspaceFile(root, 'manifest.json', manifestLimit).data);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.hasOwn(manifest, 'files')) {
    throw new Error('Use a manifest template without the generated files field');
  }
  const files = [];
  const archive = {};
  let total = 0;
  function addPayload(parts) {
    const directory = join(root, 'payload', ...parts);
    checkDirectory(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = [...parts, entry.name].join('/');
      if (!payloadPath(path)) throw new Error('Invalid payload path');
      if (entry.isDirectory()) addPayload([...parts, entry.name]);
      else {
        if (!entry.isFile() || files.length >= entryLimit - 2) throw new Error('Invalid payload entry or too many files');
        const { data, identity } = openWorkspaceFile(root, 'payload/' + path, fileLimit, undefined, 'python-payload');
        total += data.length;
        if (total > archiveLimit) throw new Error('Payload exceeds the package size limit');
        files.push({ path, size: data.length, sha256: identity.sha256 });
        archive['payload/' + path] = data;
      }
    }
  }
  if (existsSync(join(root, 'payload'))) addPayload([]);
  archive['manifest.json'] = Buffer.from(JSON.stringify({ ...manifest, files }, null, 2) + '\n');
  const packed = Buffer.from(zipSync(archive, { level: 0, mtime: new Date(2000, 0, 1) }));
  const { digest } = verifyPackage(packed);
  writeFileSync(output, packed, { flag: 'wx' });
  console.log('Packed OEP plugin SHA-256 ' + digest);
}

const args = process.argv.slice(2);
if (args.length !== 2 || !args[1].endsWith('.oepplugin')) {
  console.error('Usage: node scripts/plugins/package.mjs <source-directory> <output.oepplugin>');
  process.exit(1);
}
try { main(args); }
catch (error) {
  console.error('Plugin packaging failed' + (error?.code ? ' (' + error.code + ')' : '. Check the source manifest and payload.'));
  process.exitCode = 1;
}
