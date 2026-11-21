import { mkdirSync, mkdtempSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { startAdapter } from '../../adapter/src/main.ts';
import { checkDirectory } from '../../adapter/src/runs/workspace.ts';
import { acquireBrowserLauncher, openBrowser, requestedReopen } from './browser.ts';
import { startRuntime } from './runtime.ts';

async function launch() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required');
  const data = process.env.OEP_DATA_DIR || join(process.env.LOCALAPPDATA!, 'OEP');
  if (!isAbsolute(data)) throw new Error('The data directory must be absolute');
  const root = join(data, 'web');
  mkdirSync(root, { recursive: true });
  checkDirectory(root);
  const release = await acquireBrowserLauncher(root);
  if (!release) return;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let adapter: Awaited<ReturnType<typeof startAdapter>> | undefined;
  let reopen: NodeJS.Timeout | undefined;
  const stop = Promise.withResolvers<void>();
  process.once('SIGINT', stop.resolve);
  process.once('SIGTERM', stop.resolve);
  try {
    const profile = join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    checkDirectory(profile);
    runtime = await startRuntime(mkdtempSync(join(root, 'launch-')), undefined, profile);
    adapter = await startAdapter(root, runtime, stop.resolve, !process.env.NODE_TEST_CONTEXT);
    requestedReopen(root);
    await openBrowser(adapter.pairURL());
    const service = adapter;
    reopen = setInterval(() => {
      try {
        if (requestedReopen(root)) void openBrowser(service.pairURL()).catch(() => console.error('OEP could not reopen the browser'));
      } catch { console.error('OEP could not read its browser reopen request'); }
    }, 1_000);
    await Promise.race([stop.promise, runtime.finished.then(() => { throw new Error('OpenCode stopped'); })]);
  } finally {
    if (reopen) clearInterval(reopen);
    try { await adapter?.close(); }
    finally {
      try {
        const result = await runtime?.stop();
        if (result && (result.supervisorExit !== 0 || result.childExit !== 0 || result.orphans !== 0)) process.exitCode = 1;
      } finally { await release(); }
    }
  }
}

if (import.meta.main) {
  try { await launch(); }
  catch {
    console.error('OEP could not start or stop. Check the local OEP data directory and the setup instructions.');
    process.exitCode = 1;
  }
}
