import { sse } from './probe-http.ts';

export function redactFields(secrets: string[]) {
  const markers = [...new Set(secrets.filter(Boolean))];
  return (value: string) => {
    let decoded = value;
    for (let layer = 0; layer < 8; layer++) {
      if (markers.some((secret) => decoded.toLowerCase().includes(secret.toLowerCase()))) return '[redacted]';
      const next = decoded.replace(/(?:%[a-f\d]{2})+/gi, (part) => {
        try { return decodeURIComponent(part); } catch { return part; }
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

export async function boundedUpstreamText(response: Response) {
  if (!response.body) throw new Error('empty upstream body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let value = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return value + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > upstreamByteLimit) throw new Error('upstream body limit');
      value += decoder.decode(next.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
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
    if (done || frames.length >= 4096) throw new Error('unexpected upstream frame');
    if (data === '[DONE]') { done = true; continue; }
    const frame = JSON.parse(data) as JsonObject;
    if (!frame || typeof frame !== 'object' || frame.error || !Array.isArray(frame.choices)) throw new Error('invalid completion frame');
    for (const choice of frame.choices as JsonObject[]) {
      if (!choice || !Number.isSafeInteger(choice.index)) throw new Error('invalid choice index');
      group(choice.delta, `choice/${choice.index}`, 'delta', choice);
    }
    frames.push(frame);
  }
  if (!done || !frames.length) throw new Error('incomplete upstream stream');
  for (const pieces of groups.values()) {
    const joined = pieces.map((piece) => piece.text).join('');
    const first = pieces[0];
    let clean = redact(joined);
    if (first.field === 'arguments' && joined) {
      const parsed: unknown = JSON.parse(joined);
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
