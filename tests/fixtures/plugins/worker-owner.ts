import { readFileSync } from 'node:fs';
import { verifyPackage } from '../../../apps/adapter/src/plugins/package.ts';
import { runPython } from '../../../apps/adapter/src/plugins/python.ts';

const [, , root, archive] = process.argv;
const plugin = verifyPackage(readFileSync(archive));
const signal = new AbortController().signal;
try {
  await runPython(root, plugin, plugin.manifest.components.pythonWorkers[0], { mode: 'hang' }, signal, () => {},
    async (method, params) => {
      if (method === 'data.write' && typeof params.base64 === 'string') {
        process.send?.(Number(Buffer.from(params.base64, 'base64').toString('ascii')));
      }
      return null;
    });
} catch (error) { process.send?.(error instanceof Error ? error.message : 'worker-failed'); }
