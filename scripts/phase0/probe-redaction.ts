import { sse } from './probe-http.ts';

export function redactFields(secrets: string[]) {
  const markers = [...new Set(secrets.filter(Boolean))];
  return (value: string) => {
    let decoded = value;
    for (let layer = 0; layer < 8; layer++) {
      if (markers.some((secret) => decoded.toLowerCase().includes(secret.toLowerCase()))) return '[redacted]';
      const next = decoded.replace(/(?:%[a-f\d]{2})+/gi, (part) => {
        try { return decodeURIComponent(part); }
        catch (error) { if (error instanceof URIError) return part; throw error; }
      }).replace(/\\u([a-f\d]{4})|\\(["/\\])/gi, (_, code: string | undefined, escaped: string) =>
        code ? String.fromCharCode(Number.parseInt(code, 16)) : escaped);
      if (next === decoded) return value;
      decoded = next;
    }
    return '[redacted]';
  };
}

type Redact = ReturnType<typeof redactFields>;
export function redactJson(value: unknown, redact: Redact): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJson(item, redact)]));
  return value;
}

export const upstreamByteLimit = 2 * 1024 * 1024;

export class UpstreamFormatError extends Error {}

export function upstreamJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new UpstreamFormatError('Invalid upstream JSON');
    throw error;
  }
}

export async function boundedUpstreamText(response: Response) {
  if (!response.body) throw new UpstreamFormatError('empty upstream body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (value?: Uint8Array, stream = false) => {
    try { return decoder.decode(value, { stream }); }
    catch (error) {
      if (error instanceof TypeError && 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw new UpstreamFormatError('Invalid upstream UTF-8');
      throw error;
    }
  };
  let bytes = 0;
  let value = '';
  let cancel = true;
  try {
    for (;;) {
      cancel = false;
      const next = await reader.read();
      if (next.done) return value + decode();
      cancel = true;
      bytes += next.value.byteLength;
      if (bytes > upstreamByteLimit) throw new UpstreamFormatError('upstream body limit');
      value += decode(next.value, true);
    }
  } finally {
    try { if (cancel) await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}

type JsonObject = Record<string, unknown>;
type Piece = { object: JsonObject; field: string; text: string };

export async function bufferedCompletion(response: Response, redact: Redact) {
  const source = await boundedUpstreamText(response);
  const frames: JsonObject[] = [];
  const groups = new Map<string, Piece[]>();
  let done = false;
  const group = (value: unknown, path: string, field: string, parent: JsonObject) => {
    if (typeof value === 'string') {
      const key = JSON.stringify([path, field]);
      const pieces = groups.get(key) ?? [];
      pieces.push({ object: parent, field, text: value });
      groups.set(key, pieces);
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const semanticIndex = item && typeof item === 'object' && Number.isSafeInteger((item as JsonObject).index)
          ? (item as JsonObject).index : index;
        if (typeof item === 'string') group(item, `${path}/${field}`, String(index), value as unknown as JsonObject);
        else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
          group(child, `${path}/${field}/${semanticIndex}`, key, item as JsonObject);
        }
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) group(child, `${path}/${field}`, key, value as JsonObject);
    }
  };
  for await (const data of sse(new Response(source).body!)) {
    if (done || frames.length >= 4096) throw new UpstreamFormatError('unexpected upstream frame');
    if (data === '[DONE]') { done = true; continue; }
    const frame = upstreamJson(data) as JsonObject;
    if (!frame || typeof frame !== 'object' || frame.error || !Array.isArray(frame.choices)) throw new UpstreamFormatError('invalid completion frame');
    for (const choice of frame.choices as JsonObject[]) {
      if (!choice || !Number.isSafeInteger(choice.index)) throw new UpstreamFormatError('invalid choice index');
      group(choice.delta, `choice/${choice.index}`, 'delta', choice);
    }
    frames.push(frame);
  }
  if (!done || !frames.length) throw new UpstreamFormatError('incomplete upstream stream');
  for (const pieces of groups.values()) {
    const joined = pieces.map((piece) => piece.text).join('');
    const first = pieces[0];
    let clean = redact(joined);
    if (first.field === 'arguments' && joined) {
      const parsed = upstreamJson(joined);
      const normalized = JSON.stringify(parsed);
      const sanitized = JSON.stringify(redactJson(parsed, redact));
      clean = sanitized === normalized ? (clean === joined ? joined : JSON.stringify('[redacted]')) : sanitized;
    }
    if (clean !== joined) {
      first.object[first.field] = clean;
      for (const piece of pieces.slice(1)) piece.object[piece.field] = '';
    }
  }
  return frames.map((frame) => redactJson(frame, redact) as JsonObject);
}
