import { crc32, inflateRawSync } from 'node:zlib';

export const archiveLimit = 16 * 1024 * 1024;
export const fileLimit = 8 * 1024 * 1024;
export const manifestLimit = 128 * 1024;
export const expandedLimit = 32 * 1024 * 1024;
export const entryLimit = 258;

export class PluginError extends Error {
  constructor(readonlyCode: string) {
    super(readonlyCode);
    this.code = readonlyCode;
  }

  readonly code: string;
}

export function requirePlugin(condition: unknown, code = 'invalid-package'): asserts condition {
  if (!condition) throw new PluginError(code);
}

export function payloadPath(path: string) {
  return path.length <= 200 && /^[a-z\d][a-z\d._-]*(?:\/[a-z\d][a-z\d._-]*)*$/i.test(path) &&
    path.split('/').every((part) => part.length <= 80 && !part.endsWith('.') &&
      !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part) && part.toLowerCase() !== 'auth.json');
}

// v1 uses ordinary single-disk ZIP records with no extras, comments or data descriptors.
// Match the two headers and require complete coverage so there are no hidden local entries.
export function readArchive(bytes: Buffer) {
  requirePlugin(bytes.length >= 22 && bytes.length <= archiveLimit);
  const end = bytes.length - 22;
  const u16 = (at: number) => bytes.readUInt16LE(at);
  const u32 = (at: number) => bytes.readUInt32LE(at);
  const count = u16(end + 10);
  const central = u32(end + 16);
  requirePlugin(u32(end) === 0x06054b50 && u32(end + 4) === 0 && u16(end + 8) === count &&
    u16(end + 20) === 0 && count >= 1 && count <= entryLimit && central + u32(end + 12) === end);

  const records: { name: string; start: number; stop: number; size: number; method: number; crc: number; offset: number }[] = [];
  const seen = new Map<string, string>();
  const files = new Set<string>();
  let total = 0;
  let cursor = central;
  for (let index = 0; index < count; index++) {
    requirePlugin(cursor + 46 <= end && u32(cursor) === 0x02014b50);
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const packed = u32(cursor + 20);
    const size = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const attributes = u32(cursor + 38);
    const offset = u32(cursor + 42);
    const mode = (attributes >>> 16) & 0xf000;
    requirePlugin((flags & ~0x800) === 0 && (method === 0 || method === 8) &&
      (method !== 0 || packed === size) && (mode === 0 || mode === 0x8000) && (attributes & 0x410) === 0 &&
      u32(cursor + 30) === 0 && u16(cursor + 34) === 0 && cursor + 46 + nameLength <= end);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('latin1');
    requirePlugin(name === 'manifest.json' || name === 'manifest.sig' ||
      name.startsWith('payload/') && payloadPath(name.slice(8)));
    const parts = name.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const part = parts.slice(0, length).join('/');
      const lower = part.toLowerCase();
      requirePlugin(!files.has(lower) && (!seen.has(lower) || seen.get(lower) === part && length < parts.length));
      seen.set(lower, part);
    }
    files.add(name.toLowerCase());
    total += size;
    const limit = name === 'manifest.json' || name === 'manifest.sig' ? manifestLimit : fileLimit;
    requirePlugin(size <= limit && size <= Math.max(1, packed) * 100 && total <= expandedLimit);
    const start = offset + 30 + nameLength;
    const stop = start + packed;
    requirePlugin(stop <= central && u32(offset) === 0x04034b50 && u16(offset + 6) === flags &&
      u16(offset + 8) === method && u32(offset + 14) === crc && u32(offset + 18) === packed &&
      u32(offset + 22) === size && u16(offset + 26) === nameLength && u16(offset + 28) === 0 &&
      nameBytes.equals(bytes.subarray(offset + 30, start)));
    records.push({ name, start, stop, size, method, crc, offset });
    cursor += 46 + nameLength;
  }
  requirePlugin(cursor === end);
  let next = 0;
  const result = new Map<string, Buffer>();
  for (const { name, start, stop, size, method, crc, offset } of records.sort((a, b) => a.offset - b.offset)) {
    requirePlugin(offset === next);
    next = stop;
    const packed = bytes.subarray(start, stop);
    let data = packed;
    if (method === 8) {
      try { data = inflateRawSync(packed, { maxOutputLength: Math.max(1, size) }); }
      catch { throw new PluginError('invalid-package'); }
    }
    requirePlugin(data.length === size && crc32(data) === crc);
    result.set(name, data);
  }
  requirePlugin(next === central);
  return result;
}
