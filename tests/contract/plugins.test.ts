import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { sha256, verifyPackage } from '../../apps/adapter/src/plugins/package.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { sampleDirectory, sampleID, samplePage, samplePlugin } from '../fixtures/plugins/package.ts';

const pack = (entries: Record<string, Uint8Array>) => Buffer.from(zipSync(entries, { level: 0 }));
const owner = 'isolated owner';

function fixture() {
  const root = mkdtempSync(join(process.env.OEP_DATA_DIR ?? tmpdir(), 'plugin-test-'));
  const web = join(root, 'web.sqlite');
  const store = new WebStore(web);
  const registry = store.pluginRegistry(root, '0.8.0');
  const install = (bytes = samplePlugin(), allowIncompatible = false) => {
    registry.install(registry.preview(bytes, owner).token, true, allowIncompatible, owner);
  };
  const artifact = (pluginVersion = '1.0.0') => {
    using db = new DatabaseSync(web, { readOnly: true });
    const row = db.prepare('SELECT artifact FROM plugin_packages WHERE plugin_id = ? AND version = ?').get(sampleID, pluginVersion);
    assert.ok(row);
    return join(root, 'plugins', 'packages', sampleID, pluginVersion, row.artifact + '.oepplugin');
  };
  return { root, web, store, registry, install, artifact };
}

test('unsigned packages validate manifest, payload bytes and strict ZIP paths', () => {
  const archive = samplePlugin();
  const plugin = verifyPackage(archive);
  assert.equal(plugin.manifest.id, sampleID);
  assert.match(plugin.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(plugin.views[0].title, { en: 'Synthetic builder', 'zh-TW': '合成建置工具' });
  const entries = unzipSync(archive);
  const raw = Buffer.from(entries['manifest.json']).toString('utf8');
  for (const content of [raw.replace('"format":', '"format":"oep.plugin/v1","f\\u006frmat":'),
    raw.replace('"format":', '"unexpected":true,"format":'), raw.replace('"worker.run"', '"fs.all"'),
    raw.replace('>=0.7.0 <0.9.0', 'not a range')]) {
    assert.throws(() => verifyPackage(pack({ ...entries, 'manifest.json': Buffer.from(content) })), /invalid-package/);
  }
  assert.throws(() => verifyPackage(pack({ ...entries, 'payload/worker.py': Buffer.from('changed') })), /digest-mismatch/);
  for (const name of ['payload/../worker.py', 'payload/NUL.txt', 'payload/worker.py:stream', 'payload/Worker.py', 'other.json']) {
    assert.throws(() => verifyPackage(pack({ ...entries, [name]: Buffer.from('x') })), /invalid-package/);
  }
  const native = Buffer.from('synthetic native library placeholder');
  const withNative = JSON.parse(raw);
  withNative.files.push({ path: 'vendor/example.pyd', size: native.length, sha256: sha256(native) });
  assert.throws(() => verifyPackage(pack({ ...entries, 'manifest.json': Buffer.from(JSON.stringify(withNative)),
    'payload/vendor/example.pyd': native })), /invalid-package/);
  // Opaque extension bytes affect integrity but do not influence admission or publisher identity.
  const extended = verifyPackage(pack({ ...entries, 'manifest.sig': Buffer.from('opaque reserved bytes') }));
  assert.notEqual(extended.digest, plugin.digest);
  assert.deepEqual(extended.manifest, plugin.manifest);
});

test('developer packaging produces an unsigned archive that the host accepts', () => {
  const root = mkdtempSync(join(process.env.OEP_DATA_DIR ?? tmpdir(), 'plugin-pack-'));
  const file = join(root, 'sample.oepplugin');
  const output = execFileSync(process.execPath, ['scripts/plugins/package.mjs', sampleDirectory, file], { encoding: 'utf8', timeout: 15_000 });
  const archive = readFileSync(file);
  assert.equal(Object.hasOwn(unzipSync(archive), 'manifest.sig'), false);
  assert.ok(output.includes(verifyPackage(archive).digest));
});

test('registry requires package-specific consent, warns on compatibility, and manages versions', () => {
  const { root, registry, install, artifact, store } = fixture();
  try {
    const bytes = samplePlugin({ range: '^2.0.0' });
    const preview = registry.preview(bytes, owner);
    assert.equal(preview.compatible, false);
    assert.deepEqual(preview.permissions.operations, ['worker.run']);
    assert.throws(() => registry.install(preview.token, false, true, owner), /consent-required/);
    assert.throws(() => registry.install(preview.token, true, true, 'a different browser'), /preview-expired/);
    assert.throws(() => registry.install(preview.token, true, false, owner), /compatibility-consent/);
    assert.deepEqual(registry.list(), []);
    registry.install(preview.token, true, true, owner);
    assert.equal(registry.list()[0].compatible, false);
    assert.equal(registry.page(sampleID, samplePage, preview.digest).title.en, 'Synthetic builder');
    assert.throws(() => install(samplePlugin({ range: '^2.0.0', body: 'different' }), true), /version-conflict/);
    install(bytes, true);
    const stale = registry.preview(samplePlugin({ version: '1.1.0' }), owner);
    registry.disable(sampleID);
    assert.throws(() => registry.install(stale.token, true, false, owner), /preview-expired/);
    assert.throws(() => registry.page(sampleID, samplePage, preview.digest), /disabled/);
    assert.throws(() => registry.enable(sampleID, false), /compatibility-consent/);
    registry.enable(sampleID, true);
    const update = registry.preview(samplePlugin({ version: '1.1.0', dataRead: true }), owner);
    assert.deepEqual(update.previousPermissions?.operations, ['worker.run']);
    registry.install(update.token, true, false, owner);
    assert.deepEqual(registry.list().map(({ version, previousVersion }) => [version, previousVersion]), [['1.1.0', '1.0.0']]);
    assert.throws(() => registry.rollback(sampleID, false), /compatibility-consent/);
    registry.rollback(sampleID, true);
    assert.equal(registry.list()[0].version, '1.0.0');
    const artifacts = [artifact(), artifact('1.1.0')];
    const workspace = join(root, 'plugin-data', sampleID, 'example', 'draft.txt');
    const published = join(root, 'knowledge.sqlite');
    mkdirSync(dirname(workspace), { recursive: true });
    writeFileSync(workspace, 'local draft');
    writeFileSync(published, 'synthetic publication storage sentinel');
    assert.deepEqual(registry.uninstall(sampleID), { cleanupPending: false });
    assert.deepEqual(registry.list(), []);
    assert.ok(artifacts.every((path) => !existsSync(path)));
    assert.equal(readFileSync(workspace, 'utf8'), 'local draft');
    assert.equal(readFileSync(published, 'utf8'), 'synthetic publication storage sentinel');
  } finally { store.close(); }
});

test('startup disables a changed archive and lets the owner trust or reinstall the current version', () => {
  const { root, web, store, install, artifact } = fixture();
  install();
  const path = artifact();
  store.close();
  const replacement = samplePlugin({ body: 'Owner reviewed revised page' });
  writeFileSync(path, replacement);
  const reopened = new WebStore(web);
  const registry = reopened.pluginRegistry(root, '0.8.0');
  try {
    registry.recover();
    assert.equal(registry.list()[0].status, 'integrity-failed');
    assert.throws(() => registry.page(sampleID, samplePage, registry.list()[0].digest), /disabled/);
    assert.equal(registry.trustCurrent(sampleID, owner), undefined);
    assert.equal(registry.list()[0].status, 'enabled');
    assert.equal(registry.list()[0].digest, verifyPackage(replacement).digest);
    assert.equal(registry.page(sampleID, samplePage, registry.list()[0].digest).paragraphs[0].en, 'Owner reviewed revised page');
    writeFileSync(path, samplePlugin({ dataRead: true }));
    registry.recover();
    const preview = registry.trustCurrent(sampleID, owner);
    assert.ok(preview?.trustCurrent);
    assert.equal(registry.list()[0].status, 'integrity-failed');
    registry.install(preview.token, true, false, owner);
    assert.deepEqual(registry.list()[0].permissions.operations, ['worker.run', 'data.read']);
    writeFileSync(path, 'unreadable archive');
    assert.throws(() => registry.page(sampleID, samplePage, registry.list()[0].digest), /integrity-failed/);
    assert.throws(() => registry.trustCurrent(sampleID, owner), /reinstall-required/);
    registry.install(registry.preview(samplePlugin(), owner).token, true, false, owner);
    assert.equal(registry.list()[0].status, 'enabled');
    assert.equal(existsSync(path), false);
  } finally { reopened.close(); }
});

test('an interrupted install leaves the old selection active and clears staged and moved bytes', () => {
  const { root, web, registry, install, store } = fixture();
  try {
    install();
    const operation = randomUUID();
    const staging = join(root, 'plugins', 'staging', operation + '.oepplugin');
    const target = join(root, 'plugins', 'packages', sampleID, '1.1.0', operation + '.oepplugin');
    mkdirSync(dirname(target), { recursive: true });
    const next = samplePlugin({ version: '1.1.0' });
    for (const path of [staging, target]) writeFileSync(path, next);
    {
      using db = new DatabaseSync(web);
      db.prepare("INSERT INTO plugin_operations VALUES (?, ?, 'install', '1.1.0', NULL)").run(operation, sampleID);
    }
    registry.recover();
    assert.equal(registry.list()[0].version, '1.0.0');
    assert.equal(registry.list()[0].status, 'enabled');
    assert.ok([staging, target].every((path) => !existsSync(path)));
    using db = new DatabaseSync(web, { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS count FROM plugin_operations').get()?.count, 0);
  } finally { store.close(); }
});
