import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { canonical, sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';
import { historicalKnowledgeStore, knowledgeStorePath as storeFile } from '../fixtures/upgrade/historical-knowledge.ts';
import { seedPhase3bFixture } from '../fixtures/upgrade/phase3b.ts';
import { maintenanceFixture } from './maintenance-fixture.ts';

const manifestName = 'config/release.manifest.json';
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('upgrade and rollback reconcile data and recover interrupted swaps', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = maintenanceFixture();
  try {
    const release = resolve(process.env.OEP_TEST_RELEASE ?? 'dist/OEP-0.0.0-windows-x64.zip');
    const files = unzipSync(readFileSync(release));
    const manifest = JSON.parse(strFromU8(files[manifestName]));
    const [major, minor, patch] = manifest.version.split('.').map(Number);
    const version = [major, minor, patch + 1].join('.');
    const oldStoreCode = historicalKnowledgeStore(strFromU8(files[storeFile]));
    function fixtureZip(release: string, changed: string, files: Record<string, Uint8Array>) {
      const metadata = { ...manifest, version: release, files: manifest.files.map((file: { path: string }) =>
        (file.path === changed || file.path === storeFile) ? { ...file, sha256: sha256(files[file.path]), size: files[file.path].length } : file) };
      const name = 'OEP-' + release + '-windows-x64.zip';
      const path = join(fixture.root, name);
      const zip = zipSync({ ...files, [manifestName]: strToU8(JSON.stringify(metadata)) }, { level: 0 });
      writeFileSync(path, zip);
      appendFileSync(join(fixture.root, 'SHA256SUMS'), sha256(zip) + '  ' + name + '\n');
      return { path, zip };
    }
    const { path: v2, zip } = fixtureZip(version, storeFile, files);
    const oldVersion = manifest.version;
    const { path: v1 } = fixtureZip(oldVersion, storeFile, { ...files, [storeFile]: strToU8(oldStoreCode) });

    fixture.run('Install-OEP', ['-Source', v1]);
    const { web } = seedPhase3bFixture(fixture.data);
    const profileFile = join(web, 'profile/synthetic.txt');
    const knowledge = join(web, 'knowledge.sqlite');
    const { snapshot } = goldFixture();
    // The seeded BI vault has review history and requires a reviewed publication.
    snapshot.vault.id = 'maintenance-extended';
    snapshot.publication.revision = 'maintenance-extended';
    for (let index = 0; index < 300; index++) {
      const id = 'fixture-card-' + index;
      const text = 'Synthetic observation ' + index;
      snapshot.cards.push({ id, type: 'fixture', key: id, title: id, version: '1', fields: {} });
      snapshot.passages.push({ id, sourceId: snapshot.sources[0].id, cardId: id,
        locator: 'section ' + index, text, sha256: sha256(text) });
      snapshot.relationships.push({ from: id, to: 'fixture-card-' + ((index + 1) % 300), kind: 'references' });
    }
    const oldStore = pathToFileURL(join(fixture.install, oldVersion, storeFile)).href;
    const { KnowledgeStore: HistoricalKnowledgeStore } = await import(oldStore) as
      typeof import('../../packages/knowledge/src/store.ts');
    const before = (() => {
      const store = new HistoricalKnowledgeStore(knowledge);
      try {
        store.import(snapshot, Buffer.from(canonical(snapshot)));
        return store.retrieve(snapshot.vault.id, 'SYN-48B');
      } finally { store.close(); }
    })();
    {
      using db = new DatabaseSync(knowledge);
      db.exec(`INSERT INTO reviews(id,vault,original,draft) VALUES ('review','synthetic','{}','{}');
        INSERT INTO notification_intents VALUES ('review','synthetic','revision');
        INSERT INTO ingest_jobs(id,payload) VALUES ('job','{}');`);
    }
    const webDatabase = join(fixture.data, 'web.sqlite');
    {
      using db = new DatabaseSync(webDatabase);
      db.exec(readFileSync(new URL('../fixtures/upgrade/web-before-model-selection.sql', import.meta.url), 'utf8'));
    }
    const telegram = join(web, 'telegram.sqlite');
    const pending = (id: string) => {
      const inbox = new TelegramInbox(telegram, false);
      try { inbox.notify('main', id, 0, 'synthetic'); }
      finally { inbox.db.close(); }
    };
    const pointer = join(fixture.install, 'current.json');
    const journalPath = join(fixture.install, 'upgrade.journal.json');
    const upgrade = (...args: string[]) => fixture.run('Upgrade-OEP', ['-Source', v2, ...args]);
    const restored = () => {
      const journal = read(journalPath);
      assert.equal(journal.state, 'rolledBack');
      assert.equal(read(pointer).version, oldVersion);
      assert.equal(readFileSync(profileFile, 'utf8'), 'original profile');
      assert.equal(sha256(readFileSync(join(fixture.install, oldVersion, 'vendor/opencode/opencode.exe'))),
        sha256(files['vendor/opencode/opencode.exe']));
      const backup = read(join(journal.backup, 'backup.manifest.json'));
      for (const file of backup.inventory) assert.equal(sha256(readFileSync(join(fixture.data, file.path))), file.sha256);
      const restoredStore = new KnowledgeStore(knowledge, true);
      try {
        assert.deepEqual(restoredStore.retrieve(snapshot.vault.id, 'SYN-48B'), before);
      } finally { restoredStore.close(); }
      using db = new DatabaseSync(telegram, { readOnly: true });
      assert.deepEqual(db.prepare("SELECT id FROM outbox WHERE bot='main'").all().map((row) => row.id), ['original']);
      assert.equal(db.prepare("SELECT state FROM outbox WHERE bot='bi' AND id='previous-bi'").get()?.state, 'indeterminate');
    };
    upgrade('-WhatIf');
    assert.ok(!existsSync(journalPath));
    appendFileSync(v2, 'changed');
    fixture.run('Upgrade-OEP', ['-Source', v2], /ZIP 的 SHA-256/);
    writeFileSync(v2, zip);
    for (let cycle = 0; cycle < 2; cycle++) {
      let start = performance.now();
      assert.match(upgrade(), /資料比對通過/);
      t.diagnostic('本機升級時間 ' + Math.round(performance.now() - start) + ' ms');
      assert.equal(read(pointer).version, version);
      assert.equal(read(journalPath).migration['web/knowledge.sqlite'].before.userVersion, 1);
      assert.equal(read(journalPath).migration['web/knowledge.sqlite'].after.userVersion, 3);
      const webMigration = read(journalPath).migration['web.sqlite'];
      for (const table of ['web_model_catalog', 'web_model_selection']) {
        assert.equal(Object.hasOwn(webMigration.before.counts, table), false);
        assert.equal(webMigration.after.counts[table], 0);
      }
      for (const name of ['web/web.sqlite', 'web/telegram-chat.sqlite']) {
        const { before, after } = read(journalPath).migration[name];
        assert.equal(before.userVersion, 2);
        assert.equal(after.userVersion, name === 'web/web.sqlite' ? 13 : 3);
        assert.equal(after.counts.session_ownership, 2);
        if (name === 'web/web.sqlite') {
          assert.equal(Object.hasOwn(before.counts, 'agent_work_items'), false);
          assert.equal(after.counts.agent_work_items, 0);
          for (const table of ['delegations', 'delegation_events', 'delegation_request_keys', 'delegation_files', 'delegation_notices']) {
            assert.equal(Object.hasOwn(before.counts, table), false);
            assert.equal(after.counts[table], 0);
          }
          for (const table of ['external_helper_settings', 'external_sources', 'external_snapshots', 'external_confirmations']) {
            assert.equal(Object.hasOwn(before.counts, table), false);
            assert.equal(after.counts[table], 0);
          }
        }
      }
      const old = spawnSync(process.execPath, ['--input-type=module', '-e',
        'const { KnowledgeStore } = await import(process.argv[1]); new KnowledgeStore(process.argv[2]).close();',
        oldStore, knowledge], { encoding: 'utf8', timeout: 30_000 });
      assert.ifError(old.error);
      assert.equal(old.status, 1);
      assert.match(old.stderr, /資料庫版本比程式新/);
      const idempotent = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
        join(fixture.install, version, 'scripts/windows/migrate-data.ts'), fixture.data], { encoding: 'utf8', timeout: 30_000 });
      assert.ifError(idempotent.error);
      assert.equal(idempotent.status, 0, idempotent.stderr);
      const repeated = JSON.parse(idempotent.stdout)['web/knowledge.sqlite'];
      assert.deepEqual(repeated.before, repeated.after);
      pending('after-upgrade');
      writeFileSync(profileFile, 'upgraded profile');
      const journal = read(journalPath);
      const backupManifest = join(journal.backup, 'backup.manifest.json');
      const original = readFileSync(backupManifest);
      appendFileSync(backupManifest, ' ');
      fixture.run('Rollback-OEP', [], /備份清單與升級紀錄不符/);
      writeFileSync(backupManifest, original);
      fixture.run('Rollback-OEP', ['-WhatIf']);
      assert.equal(read(pointer).version, version);
      start = performance.now();
      fixture.run('Rollback-OEP', []);
      t.diagnostic('本機回退時間 ' + Math.round(performance.now() - start) + ' ms');
      restored();
      const safetyCopy = read(journalPath).safetyCopy;
      assert.equal(readFileSync(join(safetyCopy, 'web/profile/synthetic.txt'), 'utf8'), 'upgraded profile');
      using originalDb = new DatabaseSync(join(safetyCopy, 'web/telegram.sqlite'), { readOnly: true });
      assert.ok(originalDb.prepare("SELECT 1 FROM channel_outbound WHERE effect_key='after-upgrade' AND state='pending'").get());
      const { changes } = read(join(fixture.install, 'rollback-' + journal.id + '.json'));
      assert.equal(changes.length, 1);
      assert.equal(changes[0].table, 'channel_outbound');
      assert.equal(changes[0].addedOrChanged.length, 1);
      assert.match(fixture.run('Rollback-OEP', []), /無需再回退/);
    }

    function interrupt(script: string, point: string, args: string[]) {
      const result = spawnSync(fixture.powershell, ['-NoProfile', '-File', 'scripts/windows/' + script + '.ps1',
        '-InstallRoot', fixture.install, '-DataRoot', fixture.data, ...args],
      { encoding: 'utf8', timeout: 120_000, env: { ...fixture.env, OEP_TEST_INTERRUPT_UPGRADE: point } });
      assert.ifError(result.error);
      assert.equal(result.status, 88, result.stderr);
    }
    for (const point of ['backup', 'migration']) {
      interrupt('Upgrade-OEP', point, ['-Source', v2]);
      assert.equal(read(pointer).version, oldVersion);
      upgrade();
      restored();
    }
    upgrade();
    interrupt('Rollback-OEP', 'rollback', []);
    fixture.run('Rollback-OEP', []);
    restored();
    const currentLicense = join(fixture.install, oldVersion, 'LICENSE');
    const currentBytes = readFileSync(currentLicense);
    const pointerBytes = readFileSync(pointer);
    const previousTarget = join(fixture.install, version, 'LICENSE');
    const previousBytes = readFileSync(previousTarget);
    appendFileSync(previousTarget, 'stale build');
    const staleBytes = readFileSync(previousTarget);
    fixture.run('Upgrade-OEP', ['-Source', v2], new RegExp(
      '【' + version.replaceAll('.', '\\.') + '/LICENSE】檔案大小或 SHA-256 不符。.*非目前版本.*移出安裝根目錄'));
    assert.deepEqual(readFileSync(previousTarget), staleBytes);
    assert.deepEqual(readFileSync(currentLicense), currentBytes);
    assert.deepEqual(readFileSync(pointer), pointerBytes);
    writeFileSync(previousTarget, previousBytes);

    const migrationFile = 'scripts/windows/migrate-data.ts';
    const failedVersion = [major, minor, patch + 2].join('.');
    const failure = fixtureZip(failedVersion, migrationFile, {
      ...files,
      [migrationFile]: strToU8(`import { join } from 'node:path'; import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(join(process.argv[2], 'web', 'telegram.sqlite'));
        db.exec('DELETE FROM outbox'); db.close(); process.exit(1);`),
    });
    assert.match(fixture.run('Upgrade-OEP', ['-Source', failure.path], /新版資料庫遷移失敗/), /已回退至/);
    restored();
    assert.equal(read(journalPath).createdVersion, true);
    assert.ok(!existsSync(join(fixture.install, failedVersion)));
    assert.deepEqual(readFileSync(currentLicense), currentBytes);
    assert.deepEqual(readFileSync(previousTarget), previousBytes);

    const wrongSchemaVersion = [major, minor, patch + 3].join('.');
    const wrongSchema = fixtureZip(wrongSchemaVersion, migrationFile, {
      ...files,
      [migrationFile]: strToU8(strFromU8(files[migrationFile]) + `
        const db = new DatabaseSync(join(process.argv[2], 'web', 'knowledge.sqlite'));
        db.exec('PRAGMA user_version=1'); db.close();`),
    });
    assert.match(fixture.run('Upgrade-OEP', ['-Source', wrongSchema.path],
      /【web\/knowledge.sqlite】.*SQLite user_version 與新版不符/), /已回退至/);
    restored();
    assert.equal(read(journalPath).migration['web/knowledge.sqlite'].after.userVersion, 3);
    assert.ok(!existsSync(join(fixture.install, wrongSchemaVersion)));

    const damaged = currentLicense;
    appendFileSync(damaged, 'damaged');
    fixture.run('Upgrade-OEP', ['-Source', v1, '-AllowSameVersion']);
    assert.equal(sha256(readFileSync(damaged)), sha256(files.LICENSE));
    assert.equal(read(pointer).version, oldVersion);
    const journal = read(journalPath);
    assert.equal(journal.state, 'committed');
    assert.equal(journal.repair, true);
    const repairedKnowledge = journal.migration['web/knowledge.sqlite'];
    assert.equal(repairedKnowledge.before.userVersion, 1);
    assert.deepEqual(repairedKnowledge.after, repairedKnowledge.before);
  } finally { fixture.cleanup(); }
});

test('owned SQLite stores refuse future schemas without mutating files', () => {
  const fixture = maintenanceFixture();
  try {
    for (const open of [WebStore, KnowledgeStore, TelegramInbox]) {
      const path = join(fixture.data, open.name + '.sqlite');
      const db = new DatabaseSync(path);
      db.exec('PRAGMA user_version=99');
      db.close();
      const prior = readFileSync(path);
      assert.throws(() => new open(path), open === TelegramInbox ?
        { message: 'Telegram資料庫版本比程式新。' } : /資料庫版本比程式新/);
      assert.deepEqual(readFileSync(path), prior);
      assert.ok(!existsSync(path + '-wal'));
      assert.ok(!existsSync(path + '-shm'));
    }
  } finally { fixture.cleanup(); }
});

test('Telegram refuses a future schema committed only in a crash-left WAL without mutating files', () => {
  const fixture = maintenanceFixture();
  try {
    const path = join(fixture.data, 'telegram.sqlite');
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=99');
      process.exit(79);
    `, path], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 79, child.stderr);
    const files = [path, path + '-wal', path + '-shm'];
    const prior = files.map((file) => readFileSync(file));
    assert.equal(prior[0].readInt32BE(60), 0);
    assert.throws(() => new TelegramInbox(path), { message: 'Telegram資料庫版本比程式新。' });
    assert.deepEqual(files.map((file) => readFileSync(file)), prior);
  } finally { fixture.cleanup(); }
});
