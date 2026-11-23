import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { atRepo } from '../../../launcher/src/paths.ts';
import { HttpError } from '../http/errors.ts';

export type PickerKind = 'file' | 'folder';
export type ReferencePicker = (kind: PickerKind, locale: 'en' | 'zh-TW', signal: AbortSignal) => Promise<string[]>;

export const pickLocalReference: ReferencePicker = (kind, locale, signal) => new Promise((resolve, reject) => {
  const windows = process.env.SystemRoot;
  if (process.platform !== 'win32' || !windows) { reject(new HttpError(503, 'reference-picker-unavailable')); return; }
  execFile(join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', atRepo('scripts/windows/Pick-OEPLocalReference.ps1'),
      '-Kind', kind, '-Locale', locale], { timeout: 120_000, maxBuffer: 512 * 1024, windowsHide: true, signal,
      env: { SystemRoot: windows, WINDIR: windows, TEMP: process.env.TEMP, TMP: process.env.TMP } }, (error, output) => {
      if (!error) {
        try {
          const result: unknown = JSON.parse(output);
          if (Array.isArray(result) && result.every((path) => typeof path === 'string')) { resolve(result); return; }
        } catch { /* The chooser returns only a JSON array. */ }
      }
      reject(new HttpError(503, 'reference-picker-unavailable'));
    });
});
