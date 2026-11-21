import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { pathToFileURL } from 'node:url';

const rules = [
  ['private key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['credential token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|\d{7,12}:[A-Za-z0-9_-]{32,})\b/],
  ['embedded HTTP credentials', /https?:\/\/[^\s/@]+:[^\s/@]+@/i],
  ['assigned gateway secret', /\b(?:OEP_LITELLM_(?:API_KEY|TEST_API_KEY|BASE_URL)|LITELLM_MASTER_KEY)\s*[:=]\s*["']?\s*(?:https?:\/\/|(?:[A-Za-z0-9_+-]{20,})["'\s,;]|["'][^"'\s]{8,}["'])/i],
  ['internal hostname', /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:internal|corp|local|lan)(?![\w-]|\.[\w.-])/i],
];

function hasPrivateIPv4(text) {
  for (const [address] of text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.[\w.])/g)) {
    if (!isIPv4(address)) continue;
    const [first, second] = address.split('.').map(Number);
    if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return true;
  }
  return false;
}

function utf32(bytes, bigEndian) {
  const chunks = [];
  for (let offset = 0; offset + 3 < bytes.length; offset += 4) {
    const value = bigEndian ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset);
    chunks.push(value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : '\ufffd');
  }
  return chunks.join('');
}

export function decodeText(bytes) {
  const marker = bytes.subarray(0, 4).toString('hex');
  if (marker === 'fffe0000' || marker === '0000feff') return utf32(bytes.subarray(4), marker === '0000feff');
  if (marker.startsWith('fffe')) return new TextDecoder('utf-16le').decode(bytes);
  if (marker.startsWith('feff')) return new TextDecoder('utf-16be').decode(bytes);

  // ASCII portions of common BOM-less UTF-16/32 files have NULs on predictable byte lanes.
  const lanes = [0, 0, 0, 0];
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === 0) lanes[index % 4]++;
  const characteristic = (empty, data) => empty >= 4 && empty > 2 * data;
  if (bytes.length % 4 === 0) {
    for (const bigEndian of [false, true]) {
      const data = bigEndian ? 3 : 0;
      if (lanes.every((count, index) => index === data || characteristic(count, lanes[data]))) return utf32(bytes, bigEndian);
    }
  }
  const even = lanes[0] + lanes[2];
  const odd = lanes[1] + lanes[3];
  if (bytes.length % 2 === 0 && characteristic(odd, even)) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length % 2 === 0 && characteristic(even, odd)) return new TextDecoder('utf-16be').decode(bytes);
  // Scan an ASCII-compatible byte view if UTF-8 decoding would discard legacy 8-bit bytes.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

export function detect(text, known = []) {
  const hits = new Set();
  const scan = (value) => {
    for (const [name, rule] of rules) if (rule.test(value)) hits.add(name);
    if (hasPrivateIPv4(value)) hits.add('private IPv4');
    for (const [address] of value.matchAll(/(?<![\w:])(?:[a-f\d]{0,4}:){1,7}[a-f\d]{0,4}(?![\w:])/gi)) {
      if (/^f[cd][a-f\d]{2}:/i.test(address) && isIPv6(address)) hits.add('IPv6 unique local address');
    }
    if (known.some((secret) => secret && value.includes(secret))) hits.add('runtime gateway value');
  };

  const normalized = (value) => value.replace(/(?:%[a-f\d]{2})+/gi, (part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  }).replace(/\\(?:u([a-f\d]{4})|x([a-f\d]{2}))/gi, (_, unicode, hex) => String.fromCharCode(Number.parseInt(unicode ?? hex, 16)))
    .replace(/['"]\s*\+\s*['"]|\\\r?\n[\t ]*/g, '');

  for (let layer = 0; layer < 4; layer++) {
    scan(text);
    for (const [encoded] of text.matchAll(/(?<![\w+/-])[a-z\d+/_-]{12,4096}={0,2}(?![\w+/=-])/gi)) {
      const decoded = decodeText(Buffer.from(encoded, 'base64'));
      if (/^[\t\r\n\x20-\x7e]+$/.test(decoded)) {
        scan(decoded);
        scan(normalized(decoded));
      }
    }
    const next = normalized(text);
    if (next === text) break;
    text = next;
  }
  return [...hits];
}

if (process.argv[1] && process.argv[2] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    const staged = mode === '--staged';
    if (!staged && mode !== '--tree' && mode !== '--ref') throw new Error('mode');
    const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    const ref = mode === '--ref' && process.argv[3] ? git('rev-parse', '--verify', '--end-of-options', `${process.argv[3]}^{commit}`).toString().trim() : undefined;
    if (mode === '--ref' && !ref) throw new Error('ref');
    const paths = (ref ? git('ls-tree', '-r', '--name-only', '-z', ref)
      : staged ? git('diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z') : git('ls-files', '-z'))
      .toString('utf8').split('\0').filter(Boolean);
    const known = ['OEP_LITELLM_BASE_URL', 'OEP_LITELLM_API_KEY', 'OEP_LITELLM_TEST_API_KEY'].map((name) => process.env[name]);
    const counts = new Map();
    for (const path of paths) {
      const bytes = staged || ref ? git('show', `${ref ?? ''}:${path}`) : readFileSync(path);
      for (const match of new Set([...detect(path, known), ...detect(decodeText(bytes), known)])) {
        counts.set(match, (counts.get(match) ?? 0) + 1);
      }
    }
    const hits = [...counts.values()].reduce((total, count) => total + count, 0);
    console.log(JSON.stringify({ mode: mode.slice(2), files: paths.length, hits, rules: Object.fromEntries(counts) }));
    process.exitCode = hits ? 1 : 0;
  } catch {
    console.error('Secret scan could not read the requested Git content.');
    process.exitCode = 1;
  }
}
