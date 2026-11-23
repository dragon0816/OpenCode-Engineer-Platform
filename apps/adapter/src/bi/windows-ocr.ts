import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { atRepo } from '../../../launcher/src/paths.ts';

export type OcrLanguage = 'auto' | 'en-US' | 'zh-Hant-TW';
export type OcrLine = { text: string; box: [number, number, number, number] };
type Reading = { language: string; width: number; height: number; lines: OcrLine[] };
type Reply = { languages?: string[]; results?: Reading[]; error?: 'unavailable' | 'failed' };

function invoke(language: OcrLanguage | 'probe', signal: AbortSignal, image?: Buffer): Promise<Reply> {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return Promise.resolve({ error: 'unavailable' });
  const { SystemRoot, WINDIR } = process.env;
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = execFile(join(SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      atRepo('scripts/windows/bi-ocr.ps1'), language,
    ], { env: { SystemRoot, WINDIR }, signal, timeout: 8_000, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
      if (signal.aborted) return reject(signal.reason);
      if (!error) {
        try { return resolve(JSON.parse(stdout)); }
        catch { /* A failed projection has no usable reading. */ }
      }
      resolve({ error: 'failed' });
    });
    child.stdin?.on('error', () => { /* The child exit controls the result. */ });
    child.stdin?.end(image);
  });
}

export async function ocrLanguages(signal: AbortSignal) {
  return (await invoke('probe', signal)).languages ?? [];
}

const han = (text: string) => text.match(/\p{Script=Han}/gu)?.length ?? 0;
const alphanumeric = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

export async function windowsOcr(image: Buffer, language: OcrLanguage, signal: AbortSignal) {
  const reply = await invoke(language, signal, image);
  if (!reply.results?.length) return { warning: reply.error === 'unavailable' ? 'local-unavailable' : 'local-failed' } as const;
  const readings = reply.results.map(reading => {
    const text = reading.lines.map(line => line.text).join('\n');
    const chinese = han(text);
    const letters = alphanumeric(text);
    const words = text.match(/[a-z]{2,}/gi)?.length ?? 0;
    const noise = text.match(/[^\p{L}\p{N}\p{P}\p{S}\s]|[|_�]/gu)?.length ?? 0;
    return { ...reading, text, score: letters + chinese - 2 * noise,
      sufficient: (chinese >= 6 || words >= 4 && letters >= 16) && noise * 5 <= letters };
  });
  const best = readings.reduce((a, b) => b.score > a.score ? b : a);
  const { text, lines, width, height, sufficient, language: selected } = best;
  return { text, lines, width, height, sufficient, language: selected };
}
