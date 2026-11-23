import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { decodeText, detect } from '../phase0/secret-scan.mjs';
import { complianceArtifacts, npmComponent, openCodeComponent, productionPackages, pythonComponents } from './compliance.mjs';
import { bundleRuntimes } from './bundled.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path));
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = JSON.parse(read('config/opencode.pin.json'));
const lock = JSON.parse(read('package-lock.json'));
const upstream = 'https://github.com/anomalyco/opencode';
const asset = upstream + '/releases/download/' + pin.tag + '/' + pin.windowsX64.asset;
const spec = 'https://raw.githubusercontent.com/anomalyco/opencode/' + pin.commit + '/' + pin.openapi.path;
const npm = process.env.npm_execpath;
const exact = new Set([
  'LICENSE', 'package.json', 'package-lock.json',
  'config/opencode.pin.json', 'config/opencode.example.jsonc',
  'scripts/phase0/probe-http.ts', 'scripts/phase0/probe-listeners.ts', 'scripts/phase0/probe-redaction.ts',
  'scripts/phase0/windows-job.cs', 'scripts/knowledge/migrate.ts', 'scripts/knowledge/verify-aep-bi.py',
  'tests/oracles/verify_xlsx.py', 'tests/oracles/requirements.txt', 'tests/fixtures/d08/oracle.json',
  'tests/fixtures/knowledge/gold.ts', 'tests/fixtures/knowledge/gold.v1.json', 'tests/fixtures/knowledge/gold.v2.json',
  'workers/office/xlsx_to_text.py', 'workers/files/windows_write.py', 'workers/files/windows_probe.py',
  'docs/OPERATIONS.md', 'docs/validation/p2-windows-web.md',
]);

function verified(bytes, expected) {
  if (!(bytes instanceof Uint8Array) || sha256(bytes) !== expected) throw new Error('固定檔案的 SHA-256 不符。');
  return bytes;
}

async function download(url, expected) {
  const cache = join(root, 'dist', '.cache');
  const target = join(cache, expected);
  try { return verified(readFileSync(target), expected); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error('官方檔案下載失敗，HTTP ' + response.status + '。');
  const bytes = verified(new Uint8Array(await response.arrayBuffer()), expected);
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(join(cache, 'download-'));
  try {
    const staging = join(scratch, 'asset');
    writeFileSync(staging, bytes);
    renameSync(staging, target);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return bytes;
}

function collectPackage(files, scratch, path) {
  for (const entry of readdirSync(join(scratch, path), { withFileTypes: true })) {
    const name = path + '/' + entry.name;
    if (entry.isDirectory()) collectPackage(files, scratch, name);
    else if (entry.isFile()) files[name] = readFileSync(join(scratch, name));
    else throw new Error('套件包含不支援的檔案類型。');
  }
}

function scan(files) {
  const names = ['OEP_LITELLM_BASE_URL', 'OEP_LITELLM_API_KEY', 'OEP_LITELLM_TEST_API_KEY',
    'OEP_TELEGRAM_MAIN_BOT_TOKEN', 'OEP_TELEGRAM_BI_BOT_TOKEN', 'OEP_TELEGRAM_ALLOWED_USER_ID'];
  const known = new Set();
  for (const name of names) {
    if (process.env[name]) known.add(process.env[name]);
    if (process.platform === 'win32') {
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "[Environment]::GetEnvironmentVariable('" + name + "','User')"], { encoding: 'utf8' }).trim();
      if (value) known.add(value);
    }
  }
  const secrets = [...known];
  for (const [path, bytes] of Object.entries(files)) {
    if (/\.(exe|dll|pyd|cat|zip)$/i.test(path) && path.startsWith('vendor/')) {
      // Pinned binary payloads are checked for exact local secret bytes.
      if (secrets.some((secret) => ['utf8', 'utf16le'].some((encoding) =>
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(secret, encoding))))) {
        throw new Error('發行檔案含有本機憑證。');
      }
    } else if (detect(path, secrets).length) {
      throw new Error('發行路徑未通過敏感資料掃描。');
    } else {
      const hits = detect(decodeText(bytes), secrets);
      const upstream = path.startsWith('node_modules/') || /\bvendor\/(?:node|python)\//.test(path) ||
        path === 'vendor/opencode/openapi.json';
      // Locked upstream distributions include documentation examples and network test values.
      const blocked = upstream ? hits.filter((hit) =>
        ['runtime gateway value', 'credential token', 'private key'].includes(hit)) : hits;
      if (blocked.length) throw new Error('發行內容未通過敏感資料掃描：' + path + ' (' + blocked.join(', ') + ')');
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const bundled = args.includes('--bundled');
  const [version = JSON.parse(read('package.json')).version, output = join(root, 'dist')] = args.filter((arg) => arg !== '--bundled');
  if (!/^\d+\.\d+\.\d+$/.test(version) || !npm) throw new Error('請使用 npm run build:release，並指定三段數字版本。');
  const scratch = mkdtempSync(join(tmpdir(), 'oep-package-'));
  try {
    const files = Object.create(null);
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
    for (const path of tracked.filter((name) => exact.has(name) ||
      /^(apps|packages|scripts\/windows)\//.test(name) && !/\.test\.[^/]+$/.test(name))) {
      if (!lstatSync(join(root, path)).isFile()) throw new Error('發行來源必須是一般檔案。');
      files[path] = read(path);
    }
    for (const path of ['package.json', 'package-lock.json']) writeFileSync(join(scratch, path), files[path]);
    execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: scratch, stdio: 'ignore' });

    const components = [];
    for (const [path, entry] of productionPackages(lock)) {
      collectPackage(files, scratch, path);
      components.push(npmComponent(path, entry, files, pin));
    }
    const [archive, openapi] = await Promise.all([download(asset, pin.windowsX64.sha256), download(spec, pin.openapi.sha256)]);
    files['vendor/opencode/opencode.exe'] = verified(unzipSync(archive, { filter: ({ name }) => name === 'opencode.exe' })['opencode.exe'],
      pin.windowsX64.binarySha256);
    files['vendor/opencode/openapi.json'] = openapi;
    components.push(openCodeComponent({ name: 'OpenCode', version: pin.tag, source: asset, license: 'MIT',
      sha256: pin.windowsX64.sha256, binarySha256: pin.windowsX64.binarySha256,
      openapi: { source: spec, sha256: pin.openapi.sha256 } }, pin));
    const wheels = pythonComponents(read('tests/oracles/requirements.txt').toString('utf8'));
    components.push(...wheels);
    if (bundled) components.push(...await bundleRuntimes(files, JSON.parse(read('config/runtime.pin.json')), wheels, download));
    Object.assign(files, complianceArtifacts(components));

    const manifestPath = 'config/release.manifest.json';
    files[manifestPath] = json({ format: 1, version, platform: 'windows-x64', ...(bundled ? { variant: 'bundled' } : {}),
      components: components.map(({ text, ...component }) => component),
      files: Object.keys(files).sort().map((path) => ({ path, size: files[path].byteLength, sha256: sha256(files[path]) })) });
    const zip = zipSync(Object.fromEntries(Object.keys(files).sort().map((path) =>
      [path, files[path]])), { level: 0, mtime: new Date(2000, 0, 1) });
    scan(unzipSync(zip));
    mkdirSync(resolve(output), { recursive: true });
    const filename = 'OEP-' + version + '-windows-x64' + (bundled ? '-bundled' : '') + '.zip';
    writeFileSync(resolve(output, filename), zip);
    const sums = readdirSync(resolve(output)).filter((name) => /^OEP-\d+\.\d+\.\d+-windows-x64(?:-bundled)?\.zip$/.test(name))
      .sort().map((name) => sha256(name === filename ? zip : readFileSync(resolve(output, name))) + '  ' + name + '\n');
    writeFileSync(resolve(output, 'SHA256SUMS'), sums.join(''));
    console.log(filename + ' SHA-256 ' + sha256(zip) + '。敏感資料掃描通過。');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  // Suppress tool diagnostics that may include configuration or signed redirect URLs.
  console.error(error.constructor === Error && /^[\u4e00-\u9fff]/.test(error.message)
    ? error.message : '發行建置失敗。請檢查官方下載來源、套件鎖定檔與輸出目錄。');
  process.exitCode = 1;
}
