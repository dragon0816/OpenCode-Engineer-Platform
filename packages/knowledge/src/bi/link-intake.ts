// Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/inbox/fetch.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
// IANA special-use IPv4 ranges. Each array contains the network octets.
for (const [octets, bits] of [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24],
  [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24], [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 3],
] as const) blocked.addSubnet(octets.join('.'), bits);

export async function pinIpv4(hostname: string, allowLocal: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  const abort = Promise.withResolvers<never>();
  const cancel = () => abort.reject(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  const answers = await Promise.race([lookup(hostname, { family: 4, all: true }), abort.promise])
    .finally(() => signal.removeEventListener('abort', cancel));
  signal.throwIfAborted();
  if (!answers.length || (!allowLocal && answers.some(({ address }) => blocked.check(address)))) {
    throw new Error('來源位址受阻');
  }
  return answers[0].address;
}

export async function readApprovedLink(value: string, approved: ReadonlySet<string>, stop: AbortSignal) {
  return (await readApprovedSource(value, approved, stop, false)).bytes;
}

type LinkTransport = { pin: typeof pinIpv4; request: typeof request };
const transport = { pin: pinIpv4, request };

// Use the host's pinned HTTPS transport for the adapted page media and bounded body read.
export function readApprovedPage(value: string, approved: ReadonlySet<string>, stop: AbortSignal, io = transport) {
  return readApprovedSource(value, approved, stop, true, io);
}

async function readApprovedSource(value: string, approved: ReadonlySet<string>, stop: AbortSignal,
  page: boolean, io: LinkTransport = transport) {
  const url = new URL(value);
  if (url.href.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname) ||
      !approved.has(url.origin)) throw new Error('來源未核准');
  url.hash = '';
  const types = ['text/plain', 'text/markdown', ...(page ? ['text/html', 'application/xhtml+xml'] : [])];
  const signal = AbortSignal.any([stop, AbortSignal.timeout(8000)]);
  // Pin the address used by TLS to the public IPv4 result we validated.
  const address = await io.pin(url.hostname, false, signal);
  return await new Promise<{ bytes: Buffer; url: string; type: string; charset: string; fetchedAt: string }>((resolve, reject) => {
    const upstream = io.request(url, {
      signal, family: 4,
      lookup: (_host, _options, callback) => callback(null, address, 4),
      headers: { Accept: types.join(', '), 'Accept-Encoding': 'identity' },
    }, (response) => {
      const media = response.headers['content-type'] ?? '';
      const type = media.split(';')[0].trim().toLowerCase();
      if (response.statusCode !== 200 || !types.includes(type) ||
          response.headers['content-encoding']) {
        response.destroy();
        reject(new Error('來源無法讀取'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('來源無法讀取')));
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (page ? 512_000 : 100_000)) { response.destroy(new Error('來源超過上限')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks), url: url.href, type,
        charset: /;\s*charset="?([a-z\d_-]{1,40})/i.exec(media)?.[1] ?? '', fetchedAt: new Date().toISOString() }));
    });
    upstream.on('error', reject);
    upstream.end();
  });
}
