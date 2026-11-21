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

export async function readApprovedLink(value: string, approved: ReadonlySet<string>, stop: AbortSignal) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname) ||
      !approved.has(url.origin)) throw new Error('來源未核准');
  const signal = AbortSignal.any([stop, AbortSignal.timeout(8000)]);
  // Pin the address used by TLS to the public IPv4 result we validated.
  const answers = await lookup(url.hostname, { family: 4, all: true });
  signal.throwIfAborted();
  if (!answers.length || answers.some(({ address }) => blocked.check(address))) throw new Error('來源位址受阻');
  return await new Promise<Buffer>((resolve, reject) => {
    const upstream = request(url, {
      signal, family: 4,
      lookup: (_host, _options, callback) => callback(null, answers[0].address, 4),
      headers: { Accept: 'text/plain, text/markdown', 'Accept-Encoding': 'identity' },
    }, (response) => {
      const type = response.headers['content-type']?.split(';')[0];
      if (response.statusCode !== 200 || (type !== 'text/plain' && type !== 'text/markdown') ||
          response.headers['content-encoding']) {
        response.destroy();
        reject(new Error('來源無法讀取'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 100_000) { response.destroy(new Error('來源超過上限')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    upstream.on('error', reject);
    upstream.end();
  });
}
