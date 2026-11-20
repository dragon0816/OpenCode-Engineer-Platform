import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';

export const maxUploadBytes = 20 * 1024 * 1024;

export function uploadPolicy(name: string, mime: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxUploadBytes) return 'size';
  if (/^[a-z][a-z0-9+.-]*:/i.test(name)) return 'uri';
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\u0000-\u001f]/u.test(name) || /[. ]$/.test(name) ||
      /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i.test(name)) return 'name';
  const extensions = new Map([
    ['.png', 'image/png'],
    ['.pdf', 'application/pdf'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ]);
  return extensions.get(win32.extname(name).toLowerCase()) === mime ? 'accepted' : 'mime';
}

export function inspectStagedFile(root: string, name: string, mime: string) {
  if (uploadPolicy(name, mime, 1) !== 'accepted') return 'rejected';
  const target = join(root, name);
  const attributes = lstatSync(target);
  if (!attributes.isFile() || attributes.isSymbolicLink() || attributes.nlink !== 1) return 'rejected';
  if (dirname(realpathSync(target)) !== realpathSync(root)) return 'rejected';
  return uploadPolicy(name, mime, attributes.size);
}
