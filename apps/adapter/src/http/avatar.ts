import { HttpError } from './errors.ts';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxBytes = 90 * 1024;
const maxDimension = 1024;
const jpegFrames = new Set([0xc0, 0xc1, 0xc2]);

function jpegDimensions(bytes: Buffer) {
  let offset = 2;
  while (offset + 4 < bytes.length && bytes[offset++] === 0xff) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length) return;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length || marker === 0xda) return;
    if (jpegFrames.has(marker) && size >= 8) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += size;
  }
}

export function parseAvatar(value: unknown) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string' || value.length > maxBytes * 4 / 3 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new HttpError(400, 'avatar-type-or-size');
  }
  const bytes = Buffer.from(value, 'base64');
  let mime;
  let dimensions;
  if (bytes.toString('base64') === value && bytes.length <= maxBytes) {
    if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) &&
        bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
      mime = 'image/png';
      dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    } else if (bytes.length >= 12 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
      mime = 'image/jpeg';
      dimensions = jpegDimensions(bytes);
    }
  }
  if (!mime || !dimensions || dimensions.some((dimension) => !dimension || dimension > maxDimension)) {
    throw new HttpError(400, 'avatar-dimensions');
  }
  return { bytes, mime };
}
