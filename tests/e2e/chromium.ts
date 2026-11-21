import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { until, waitForExit } from '../../scripts/phase0/probe-http.ts';

export async function chromium(profile: string) {
  const binary = process.env.OEP_TEST_BROWSER || [
    join(process.env['ProgramFiles(x86)']!, 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles!, 'Google/Chrome/Application/chrome.exe'),
  ].find(existsSync);
  if (!binary) throw new Error('Chromium browser unavailable');
  const browser = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-background-networking', '--window-size=1280,900', 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
  const exited = Promise.withResolvers<void>();
  browser.once('exit', () => exited.resolve());
  browser.once('error', () => exited.resolve());
  const sockets = new Set<WebSocket>();
  const close = async () => {
    for (const socket of sockets) socket.close();
    browser.kill();
    await waitForExit(exited.promise, 5_000);
  };
  try {
    const devtools = join(profile, 'DevToolsActivePort');
    const port = await until(async () => {
      if (!existsSync(devtools)) return;
      return Number(readFileSync(devtools, 'utf8').split(/\r?\n/)[0]) || undefined;
    });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
      { type: string; webSocketDebuggerUrl: string }[];
    const url = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl;
    if (!url) throw new Error('Chromium page unavailable');
    const socket = new WebSocket(url);
    sockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Chromium debugger connection failed')), { once: true });
    });
    const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
    let sequence = 0;
    socket.addEventListener('message', (event) => {
      const { id, result, error } = JSON.parse(String(event.data));
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (error) request.reject(new Error('Chromium command failed'));
      else request.resolve(result);
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) request.reject(new Error('Chromium debugger closed'));
      pending.clear();
    });
    async function command<T>(method: string, params: object = {}) {
      const id = ++sequence;
      const result = Promise.withResolvers<unknown>();
      pending.set(id, result);
      const timeout = setTimeout(() => {
        pending.delete(id);
        result.reject(new Error(`Chromium command timed out: ${method}`));
      }, 10_000);
      try {
        socket.send(JSON.stringify({ id, method, params }));
        return await result.promise as T;
      } finally { clearTimeout(timeout); }
    }
    async function evaluate<T>(expression: string) {
      const { result, exceptionDetails } = await command<{ result: { value: T }; exceptionDetails?: unknown }>(
        'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error('Browser evaluation failed');
      return result.value;
    }
    return { command, evaluate, close,
      ready: (expression: string, timeout = 12_000) => until(async () => await evaluate<boolean>(expression) || undefined, timeout),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
