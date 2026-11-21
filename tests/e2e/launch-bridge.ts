import assert from 'node:assert/strict';
import processes, { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { webAPI } from './web-api.ts';

const root = process.env.OEP_DATA_DIR!;
let watching = false;

async function capture(url: string) {
  const api = await webAPI(url);
  const info = await (await api.get('/api/bootstrap')).json();
  assert.equal(info.version, '2.3.2');
  if (!watching) {
    watching = true;
    void (async () => {
      try {
        for await (const entry of watch(root)) {
          if (entry.filename !== 'stop-test') continue;
          assert.equal((await api.post('/api/stop', {})).status, 202);
          break;
        }
      } catch {
        console.error('Launcher stop test failed');
        process.exitCode = 1;
        process.emit('SIGTERM');
      }
    })();
  }
  appendFileSync(join(root, 'browser.jsonl'), `${JSON.stringify({ pid: process.pid, origin: api.origin })}\n`);
}

// Replace only the final ShellExecute handoff to leave the user's browser profile untouched.
const original = processes.execFile;
processes.execFile = ((...args: unknown[]) => {
  const [binary, , options, callback] = args as [
    string, string[], { env?: NodeJS.ProcessEnv } | undefined, (error?: Error) => void,
  ];
  const url = options?.env?.OEP_BROWSER_URL;
  if (!url || !binary.toLowerCase().endsWith('\\powershell.exe')) return Reflect.apply(original, processes, args);
  if (process.send) {
    process.send(url);
    callback();
    return new ChildProcess();
  }
  void capture(url).then(() => callback(), () => callback(new Error('Browser handoff failed')));
  return new ChildProcess();
}) as typeof original;
syncBuiltinESMExports();
