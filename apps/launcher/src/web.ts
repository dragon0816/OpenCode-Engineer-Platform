import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { startAdapter } from '../../adapter/src/main.ts';
import { checkDirectory } from '../../adapter/src/runs/workspace.ts';
import { acquireBrowserLauncher, openBrowser, requestedReopen } from './browser.ts';
import { repo } from './paths.ts';
import { startRuntime } from './runtime.ts';

function installedRoot() {
  if (!/^\d+\.\d+\.\d+$/.test(basename(repo)) || !existsSync(join(repo, 'config/release.manifest.json'))) return;
  return dirname(repo);
}

function checkMaintenance(install: string) {
  const journal = join(install, 'upgrade.journal.json');
  if (existsSync(join(install, 'upgrade.active')) || (existsSync(journal) &&
      !['committed', 'rolledBack'].includes(JSON.parse(readFileSync(journal, 'utf8')).state))) {
    throw new Error('OEP 升級或回退尚未完成。請先執行回退。');
  }
}

async function launch() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required');
  const data = process.env.OEP_DATA_DIR || join(process.env.LOCALAPPDATA!, 'OEP');
  if (!isAbsolute(data)) throw new Error('The data directory must be absolute');
  const install = installedRoot();
  if (install) checkMaintenance(install);
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
        if (install && existsSync(join(install, 'stop-' + process.pid + '.request'))) stop.resolve();
        else if (requestedReopen(root)) void openBrowser(service.pairURL()).catch(() => console.error('OEP could not reopen the browser'));
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
  catch (error) {
    if (error instanceof Error && /^(?:執行紀錄|知識|Telegram)資料庫版本比程式新。$/.test(error.message.split('請')[0])) {
      console.error('資料庫版本比程式新。請使用新版程式或先回退資料。');
    } else if (error instanceof Error && error.message === 'OEP 升級或回退尚未完成。請先執行回退。') {
      console.error(error.message);
    } else console.error('OEP could not start or stop. Check the local OEP data directory and the setup instructions.');
    process.exitCode = 1;
  }
}
