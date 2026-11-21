import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { verifyCitations } from '../../packages/contracts/src/evidence.ts';
import { canonical, sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';
import { maintenanceFixture } from './maintenance-fixture.ts';

test('online backup and staged restore', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = maintenanceFixture();
  const database = join(fixture.data, 'synthetic.sqlite');
  const backups = join(fixture.root, 'backups');
  const prior = join(fixture.root, 'prior');
  const db = new DatabaseSync(database);
  let writer: ReturnType<typeof spawn> | undefined;
  try {
    const web = join(fixture.data, 'web');
    mkdirSync(web);
    const webDatabase = join(web, 'web.sqlite');
    const mcpStore = new WebStore(webDatabase);
    const marker = 'synthetic-mcp-backup-value';
    const definition = mcpStore.saveCustomStdioMcp('c'.repeat(32), {
      name: '合成 MCP', transport: 'stdio', enabled: true, command: [process.execPath], cwd: fixture.data,
      environment: ['FIXTURE_TOKEN'], timeouts: { startup: 1000, catalog: 1000, execution: 1000 },
      dataScope: '合成資料', appliesToProjects: ['secondary'], ignoredValue: marker,
    });
    mcpStore.close();
    db.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=4;');
    const counts = { vaults: 1, publications: 1, cards: 1000, passages: 5000, evidence: 10000,
      relations: 2000, reviews: 20, sessions: 10, run_ledger: 40, bi_jobs: 20, inbox: 40, outbox: 40 };
    for (const [table, count] of Object.entries(counts)) {
      db.exec('CREATE TABLE ' + table + '(id INTEGER PRIMARY KEY, state TEXT);');
      db.exec('WITH RECURSIVE rows(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM rows WHERE x < ' +
        count + ') INSERT INTO ' + table + " SELECT x, 'synthetic' FROM rows;");
    }
    db.exec("CREATE TABLE writer(state TEXT); INSERT INTO writer VALUES ('opening');");
    const { snapshot } = goldFixture();
    for (let index = 0; index < 1000; index++) {
      const id = 'fixture-card-' + index;
      snapshot.cards.push({ id, type: 'fixture', key: id, title: id, version: '1', fields: { state: 'published' } });
      for (let part = 0; part < 5; part++) {
        const text = 'Synthetic observation ' + index + ' part ' + part;
        snapshot.passages.push({ id: id + '-' + part, sourceId: snapshot.sources[0].id, cardId: id,
          locator: 'section ' + part, text, sha256: sha256(text) });
      }
      for (const distance of [1, 2]) {
        snapshot.relationships.push({ from: id, to: 'fixture-card-' + ((index + distance) % 1000), kind: 'references' });
      }
    }
    const knowledgePath = join(fixture.data, 'knowledge.sqlite');
    const store = new KnowledgeStore(knowledgePath);
    const vault = snapshot.vault.id;
    store.import(snapshot, Buffer.from(canonical(snapshot)));
    const before = store.retrieve(vault, 'SYN-48B');
    store.close();
    assert.ok(before);
    writer = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
      "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); " +
      "const add=db.prepare(\"UPDATE writer SET state='writing'\"); add.run(); console.log('ready'); " +
      'setInterval(() => { add.run(); }, 20);', database], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(writer.stdout!, 'data');
    fixture.run('Backup-OEP', ['-Destination', backups, '-WhatIf']);
    assert.ok(!existsSync(backups));
    let start = performance.now();
    fixture.run('Backup-OEP', ['-Destination', backups]);
    t.diagnostic('本機備份時間 ' + Math.round(performance.now() - start) + ' ms');
    const ended = once(writer, 'exit');
    writer.kill();
    await ended;
    writer = undefined;
    db.close();
    const backup = join(backups, readdirSync(backups)[0]);
    const manifest = join(backup, 'backup.manifest.json');
    const original = readFileSync(manifest);
    const metadata = JSON.parse(original.toString());
    const credential = definition.environment[0].reference;
    assert.ok(metadata.credentials.includes(credential));
    assert.equal(original.includes(marker), false);
    assert.equal(readFileSync(join(backup, 'web', 'web.sqlite')).includes(marker), false);
    assert.deepEqual(Object.values(metadata.databases['knowledge.sqlite'].publicationCounts), [{
      cards: snapshot.cards.length, passages: snapshot.passages.length, evidence: 0, relations: snapshot.relationships.length,
    }]);
    for (const [table, count] of Object.entries(counts)) {
      assert.equal(metadata.databases['synthetic.sqlite'].counts[table], count);
    }
    fixture.run('Restore-OEP', ['-Backup', backup], /已有檔案/);
    metadata.databases['synthetic.sqlite'].counts.cards = 0;
    writeFileSync(manifest, JSON.stringify(metadata));
    fixture.run('Restore-OEP', ['-Backup', backup, '-Force', '-ConfirmReplaceData', 'REPLACE OEP DATA'], /比對失敗/);
    assert.ok(existsSync(database));
    writeFileSync(manifest, original);
    const stored = join(backup, 'synthetic.sqlite');
    const bytes = readFileSync(stored);
    bytes[0] ^= 1;
    writeFileSync(stored, bytes);
    fixture.run('Restore-OEP', ['-Backup', backup], /SHA-256 不符/);
    bytes[0] ^= 1;
    writeFileSync(stored, bytes);
    writeFileSync(join(fixture.data, 'old.txt'), 'original');
    fixture.run('Restore-OEP', ['-Backup', backup, '-Force', '-ConfirmReplaceData', 'REPLACE OEP DATA'], 87);
    assert.equal(readFileSync(join(fixture.data, 'old.txt'), 'utf8'), 'original');
    assert.ok(readdirSync(fixture.root).some((name) => name.startsWith('data.oep-restore-staging-')));
    fixture.run('Restore-OEP', ['-Backup', backup, '-Force', '-ConfirmReplaceData', 'REPLACE OEP DATA']);
    assert.ok(existsSync(fixture.data + '.oep-safety-backups'));
    renameSync(fixture.data, prior);
    start = performance.now();
    fixture.run('Restore-OEP', ['-Backup', backup]);
    t.diagnostic('本機回復時間 ' + Math.round(performance.now() - start) + ' ms');
    const restoredMcp = new WebStore(webDatabase);
    try { assert.deepEqual(restoredMcp.customMcpServers(), [definition]); }
    finally { restoredMcp.close(); }
    const restored = new DatabaseSync(database, { readOnly: true });
    try {
      for (const [table, count] of Object.entries(counts)) {
        assert.equal(restored.prepare('SELECT count(*) AS n FROM ' + table + " WHERE state='synthetic'").get()?.n, count);
      }
      assert.equal(restored.prepare('SELECT state FROM writer').get()?.state, 'writing');
    } finally { restored.close(); }
    const knowledge = new KnowledgeStore(knowledgePath);
    try {
      assert.deepEqual(knowledge.snapshot(vault, snapshot.publication.revision), snapshot);
      const after = knowledge.retrieve(vault, 'SYN-48B');
      assert.deepEqual(after, before);
      const passage = before.passages[0];
      assert.equal(verifyCitations({ question: 'SYN-48B', revision: before.revision, passages: after!.passages },
        [{ passageID: passage.id, source: passage.source, locator: passage.locator, sha256: passage.sha256,
          quote: passage.text }]).state, 'verified');
    } finally { knowledge.close(); }
    const unrelated = join(backups, 'OEP-backup-20000101T0000000000000Z-' + '0'.repeat(32));
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'backup.manifest.json'), '{}');
    fixture.run('Backup-OEP', ['-Destination', backups, '-KeepLast', '1']);
    assert.ok(existsSync(unrelated));
    assert.ok(!existsSync(backup));
  } finally {
    if (writer) { const ended = once(writer, 'exit'); writer.kill(); await ended; }
    if (db.isOpen) db.close();
    fixture.cleanup();
  }
});
