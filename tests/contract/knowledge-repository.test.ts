import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { importKnowledgeRepository } from '../../apps/launcher/src/knowledge.ts';
import { KnowledgeAsk } from '../../packages/knowledge/src/ask.ts';
import { inspectRepository, readRepository } from '../../packages/knowledge/src/repository.ts';
import { sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';
import { forecast, forecastQuestions, forecastRepository, sentinels, syntheticRepository } from '../fixtures/knowledge/repository.ts';

function testFolder() {
  mkdirSync('.phase0', { recursive: true });
  return mkdtempSync(resolve('.phase0', 'repo-reader-'));
}

function fingerprints(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => ({ name: join(entry.parentPath, entry.name), hash: sha256(readFileSync(join(entry.parentPath, entry.name))) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('retrieves a bilingual forecast from a noisy mirror and verifies the original citation', async () => {
  const folder = testFolder();
  const fixture = forecastRepository(folder);
  const { snapshot, original } = readRepository(folder);
  const vault = snapshot.vault.id;
  const forecastId = fixture.evidenceIds.get('forecast');
  const store = new KnowledgeStore(':memory:');
  try {
    store.import(snapshot, original, true);
    let calls = 0;
    const ask = new KnowledgeAsk(store, async (_question, evidence) => {
      calls++;
      assert.ok(evidence.length <= 5);
      assert.equal(new Set(evidence.map((passage) => passage.text)).size, evidence.length);
      const passage = evidence.find(({ id }) => id === forecastId);
      assert.equal(passage?.text, forecast);
      const duplicate = evidence.find(({ text }) => text.endsWith('is pending.'));
      assert.ok(duplicate);
      const copies = snapshot.passages.filter(({ text }) => text === duplicate.text);
      assert.equal(copies.length, 12);
      assert.deepEqual(duplicate.provenance.map(({ id, sourceId, cardId, locator, sha256 }) =>
        ({ id, sourceId, cardId, locator, sha256 })), copies.map(({ id, sourceId, cardId, locator, sha256 }) =>
        ({ id, sourceId, cardId, locator, sha256 })));
      return { content: JSON.stringify({ state: 'answer', citations: [{ passageID: forecastId, quote: '2032 年 1.6T 燈具可達 480 台' }] }) };
    });
    for (const question of forecastQuestions) {
      const result = await ask.ask({ vault, question }, new AbortController().signal);
      assert.equal(result.state, 'verified');
      assert.equal(result.answer, '2032 年 1.6T 燈具可達 480 台');
      const [citation] = result.citations;
      const stored = snapshot.passages.find(({ id }) => id === citation.passageID)!;
      assert.equal(citation.sha256, sha256(stored.text));
      assert.equal(citation.locator, stored.locator);
      assert.equal(citation.sourceId, stored.sourceId);
      assert.equal(citation.source, snapshot.sources.find(({ id }) => id === stored.sourceId)?.ref);
    }
    assert.equal((await ask.ask({ vault, question: 'What is the warranty for SYN-999?' },
      new AbortController().signal)).reason, 'no-evidence');
    assert.equal(calls, 2);
  } finally { store.close(); }
});

test('preserves full Recall@5 on the published gold repository mirror', () => {
  const folder = testFolder();
  const { snapshot, questions } = goldFixture();
  const fixture = syntheticRepository(folder, { snapshot });
  const input = readRepository(folder);
  const store = new KnowledgeStore(':memory:');
  try {
    store.import(input.snapshot, input.original, true);
    for (const question of questions.filter(({ class: kind }) => kind === 'answerable')) {
      const hits = store.retrieve(snapshot.vault.id, question.query)?.passages.map(({ id }) => id) ?? [];
      assert.ok(hits.length <= 5);
      for (const id of question.evidence) assert.ok(hits.includes(fixture.evidenceIds.get(id)!), question.id);
    }
  } finally { store.close(); }
});

test('repository publications use clock, author, then sequence along with the exact tag and commit', () => {
  const folder = testFolder();
  const fixture = syntheticRepository(folder, { republish: false, metadata: false });
  assert.equal(readRepository(folder).snapshot.repository?.tag, 'tag-b');
  assert.equal(inspectRepository(folder).repository.type, 'bi');
  fixture.publish('tag-b', 7, 4);
  fixture.publish('tag-a', 7, 1, {}, 'author-b');
  assert.equal(readRepository(folder).snapshot.repository?.tag, 'tag-a');
  fixture.publish('tag-b', 7, 2, {}, 'author-b');
  assert.equal(readRepository(folder).snapshot.repository?.tag, 'tag-b');
  fixture.publish('tag-a', 8, 5);
  const active = readRepository(folder);
  assert.equal(active.snapshot.repository?.tag, 'tag-a');
  assert.equal(active.snapshot.repository?.commit, fixture.commits.get('tag-a'));
  assert.equal(active.digestVerified, true);
  assert.equal(active.sizeVerified, true);
});

test('repository import maps evidence and versions, switches atomically, and preserves rollback generations', () => {
  const root = testFolder();
  const folder = join(root, 'repository');
  const destination = join(root, 'store', 'knowledge.sqlite');
  const fixture = syntheticRepository(folder, { republish: false });
  const previousInput = readRepository(folder);
  const beforeFirst = fingerprints(folder);
  const first = importKnowledgeRepository(destination, folder);
  assert.equal(first.tag, 'tag-b');
  assert.equal(first.active, true);
  assert.deepEqual(fingerprints(folder), beforeFirst);
  const reader = new KnowledgeStore(destination, true);
  try {
    fixture.publish('tag-a', 6, 3, { at: '2025-01-01T00:00:00Z' });
    const before = fingerprints(folder);
    const second = importKnowledgeRepository(destination, folder, true);
    assert.equal(second.tag, 'tag-a');
    assert.equal(second.active, true);
    assert.equal(second.schemaVersion, '5.0.0+synthetic');
    assert.deepEqual(fingerprints(folder), before);
    const current = reader.snapshot(fixture.repo)!;
    assert.equal(current.publication.revision, second.revision);
    assert.equal(current.cards[0].version, '3');
    assert.equal(current.cards[0].fields['field-x'], sentinels.row);
    assert.equal((current.cards[0].fieldProvenance?.['field-x'] as { ref: string }).ref, 'tag-a');
    assert.equal(current.relationships[0].provenance?.status, 'confirmed');
    assert.equal(current.repository?.history?.length, 1);
    assert.equal(current.repository?.relationEvidence?.[0].reference_id, 'reference-1');
    assert.equal(current.repository?.evidence?.length, 2);
    const retrieved = reader.retrieve(fixture.repo, 'SYN-123 operation X')!;
    assert.equal(retrieved.allowModel, true);
    assert.deepEqual(retrieved.passages.map(({ text, locator, sourceVersion }) => ({ text, locator, sourceVersion })),
      [{ text: `SYN-123 supports operation X. ${sentinels.excerpt}`, locator: '#L2-L4', sourceVersion: '1' }]);
    const firstSnapshot = reader.snapshot(fixture.repo, first.revision);
    assert.equal(firstSnapshot?.repository?.tag, 'tag-b');

    fixture.publish('tag-b', 9, 4, { snapshot: { path: 'published/tag-b.sqlite', sha256: '0'.repeat(64) } });
    assert.throws(() => importKnowledgeRepository(destination, folder), /SHA-256 mismatch/);
    assert.equal(reader.overview()[0].revision, second.revision);
    assert.equal(reader.retrieve(fixture.repo, 'SYN-123')?.revision, second.revision);

    const writer = new KnowledgeStore(destination);
    try {
      assert.equal(writer.import(previousInput.snapshot, previousInput.original).state, 'existing');
      assert.equal(reader.overview()[0].revision, second.revision);
      writer.restoreRepositoryGeneration(fixture.repo, first.revision);
      assert.equal(reader.overview()[0].revision, first.revision);
      writer.restoreRepositoryGeneration(fixture.repo, second.revision);
      assert.equal(reader.overview()[0].revision, second.revision);
      const invalid = structuredClone(current);
      invalid.publication.revision = 'uncommitted';
      invalid.repository!.clock = 10;
      invalid.passages[0].sha256 = '0'.repeat(64);
      assert.throws(() => writer.import(invalid, Buffer.from('invalid')), /passages/);
      assert.equal(reader.snapshot(fixture.repo, 'uncommitted'), undefined);
      assert.equal(reader.overview()[0].revision, second.revision);
    } finally { writer.close(); }
  } finally { reader.close(); }
});

test('repository import fails closed on sync gaps, corruption, mismatches, and output inside the source', () => {
  const folder = testFolder();
  const fixture = syntheticRepository(folder);
  const destination = join(folder, 'unused', 'knowledge.sqlite');
  assert.throws(() => importKnowledgeRepository(destination, folder), /outside the source/);
  assert.equal(existsSync(join(folder, 'unused')), false);
  for (const [path, message] of [
    ['published/empty.sqlite', /empty or has not synced/],
    ['published/missing.sqlite', /missing or has not synced/],
    ['published/corrupt.sqlite', /Invalid SQLite header/],
    ['published/../repo.json.sqlite', /Unsafe repository path/],
  ] as const) {
    fixture.publish('tag-b', 20, 4, { snapshot: { path } });
    assert.throws(() => readRepository(folder), message);
  }
  fixture.publish('tag-b', 20, 4, { snapshot: { path: 'published/tag-b.sqlite', size: 1 } });
  assert.throws(() => readRepository(folder), /size mismatch/);
  fixture.publish('tag-b', 20, 4, { snapshot: null });
  assert.throws(() => readRepository(folder), /no SQLite snapshot/);
  fixture.publish('tag-b', 20, 4, { snapshot: undefined });
  assert.equal(readRepository(folder).digestVerified, false);
  writeFileSync(join(folder, 'published', 'tag-b.sqlite-wal'), 'pending');
  assert.throws(() => readRepository(folder), /nonempty journal or WAL/);
  fixture.publish('tag-a', 20, 4, { commit: 'f'.repeat(64) });
  assert.throws(() => readRepository(folder), /Tag does not match/);
  fixture.publish('tag-a', 20, 4);
  fixture.json('publish/author-a/5.json', {});
  assert.throws(() => readRepository(folder), /Invalid publication/);
  assert.equal(inspectRepository(folder).publication.state, 'unresolved');
  const empty = testFolder();
  assert.equal(inspectRepository(empty).publication.state, 'no published version');
  assert.throws(() => readRepository(empty), /No published version/);
  const wiki = testFolder();
  const wikiFixture = syntheticRepository(wiki);
  wikiFixture.json('repo.json', { id: wikiFixture.repo, type: 'wiki' });
  assert.equal(inspectRepository(wiki).repository.type, 'wiki');
  assert.throws(() => readRepository(wiki), /Wiki repository folders/);
});

test('repository inspect CLI emits schema and counts without row values, tag names, or nested filenames', () => {
  const root = testFolder();
  syntheticRepository(root);
  const inspect = (...flags: string[]) => spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', 'scripts/knowledge/inspect.ts', root, ...flags,
  ], { encoding: 'utf8' });
  const result = inspect();
  assert.equal(result.status, 1); // Decoys are diagnosed even when the active snapshot resolves.
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.folders.find((entry: { folder: string }) => entry.folder === 'applications').extensions, { '.md': 1 });
  assert.equal(data.publication.tag, 'resolved-tag');
  assert.equal(data.publication.state, 'resolved');
  assert.equal(data.sqlite.length, 5);
  const active = data.sqlite.find((file: { selected: boolean }) => file.selected);
  assert.equal(active.userVersion, 14);
  assert.equal(active.tables.find((entry: { table: string }) => entry.table === 'evidence').rows, 2);
  assert.ok(active.tables.find((entry: { table: string }) => entry.table === 'evidence').columns.includes('excerpt'));
  assert.equal(data.errors.length, 2);
  for (const value of [...Object.values(sentinels), root, 'tag-a', 'author-a', 'segment-a', 'kind-x', '5.0.0+synthetic']) {
    assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value), value);
  }
  const named = inspect('--show-names');
  assert.equal(JSON.parse(named.stdout).publication.tag, 'tag-a');
  assert.match(named.stdout, /published\/tag-a\.sqlite/);
  for (const value of [sentinels.row, sentinels.excerpt, root]) assert.ok(!named.stdout.includes(value));
});
