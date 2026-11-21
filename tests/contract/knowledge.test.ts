import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { KnowledgeAsk, parseAsk } from '../../packages/knowledge/src/ask.ts';
import type { KnowledgeModel } from '../../packages/knowledge/src/ask.ts';
import { publishedInput } from '../../packages/knowledge/src/convert-aep.ts';
import { canonical, sha256, validateSnapshot } from '../../packages/knowledge/src/snapshot.ts';
import type { Snapshot } from '../../packages/knowledge/src/snapshot.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';

const active = () => AbortSignal.timeout(5000);
const data = (value: unknown) => Buffer.from(canonical(value));
const root = () => {
  mkdirSync('.phase0', { recursive: true });
  return mkdtempSync(join('.phase0', 'knowledge-test-'));
};
const guess = (passageID: string, quote: string) =>
  ({ content: JSON.stringify({ state: 'answer', citations: [{ passageID, quote }] }) });

test('imports and restores content-addressed published snapshots, preserving revisions, sources, and relations', () => {
  const folder = root();
  const path = join(folder, 'knowledge.sqlite');
  const backup = join(folder, 'backup.sqlite');
  const { snapshot } = goldFixture();
  snapshot.relationships.push({ from: 'calibration', to: 'ground', kind: 'references' });
  const draft = { ...snapshot, status: 'draft' } as unknown as Snapshot;
  const latest = structuredClone(snapshot);
  latest.publication = { revision: 'gold.v3', parent: 'gold.v2', publishedAt: '2026-01-02T00:00:00Z', publisher: 'synthetic' };
  latest.passages = latest.passages.filter((passage) => passage.id !== 'calibration');
  const store = new KnowledgeStore(path);
  const vault = snapshot.vault.id;
  try {
    assert.throws(() => store.import(draft, data(draft)), /format\/status/);
    assert.throws(() => validateSnapshot({ ...snapshot, relationships: [{ from: 'calibration', to: 'unmapped', kind: 'references' }] }), /relationships/);
    assert.throws(() => validateSnapshot({ ...snapshot, passages: [{ ...snapshot.passages[0], text: 'Changed' }] }), /sha256/);
    const imported = store.import(snapshot, data(snapshot));
    assert.equal(imported.state, 'imported');
    assert.equal(store.retrieve(vault, 'SYN-48B')?.allowModel, false);
    assert.equal(store.import(snapshot, data(snapshot), true).state, 'existing');
    assert.equal(store.retrieve(vault, 'ＳＹＮ－４８Ｂ')?.passages[0].id, 'calibration');
    assert.equal(store.retrieve(vault, '接地電阻')?.passages[0].id, 'ground');
    assert.equal(store.retrieve(vault, 'PX-7210')?.passages[0].id, 'sampling-neighbor');
    assert.ok(store.retrieve(vault, '墊')?.passages.some((passage) => passage.id === 'spacer'));
    assert.equal(store.retrieve(vault, 'zero OR "*)"-unmatched')?.passages.length, 0);
    assert.equal(store.retrieve(vault, '±0.8 dB')?.passages[0].id, 'calibration');
    assert.throws(() => store.import({ ...snapshot, vault: { ...snapshot.vault, title: 'Changed' } }, data(snapshot)), /different content/);
    store.import(latest, data(latest), true);
    assert.deepEqual(store.retrieve(vault, 'SYN-48B')?.passages, []);
    assert.deepEqual(store.snapshot(vault, 'gold.v2'), snapshot);
    assert.equal(store.rebuild(), 2);
    store.backup(backup);
  } finally { store.close(); }
  const restored = new KnowledgeStore(backup, true);
  try {
    assert.deepEqual(restored.snapshot(vault), latest);
    assert.deepEqual(restored.snapshot(vault, 'gold.v2'), snapshot);
    assert.equal(restored.overview()[0].relationships, 1);
    assert.equal(restored.retrieve(vault, 'TRQ-14')?.passages[0].locator, '合成治具手冊#row=21');
  } finally { restored.close(); }
});

test('performs retrieval before inference and fails closed on wrong, stale, or unrelated evidence', async () => {
  const { snapshot } = goldFixture();
  const path = join(root(), 'knowledge.sqlite');
  const store = new KnowledgeStore(path);
  const writer = new DatabaseSync(path);
  const vault = snapshot.vault.id;
  const input = { vault, question: 'SYN-48B 的零點容差？' };
  let calls = 0;
  let model: KnowledgeModel = async (_question, evidence) => {
    assert.deepEqual(evidence.map((passage) => passage.id), ['calibration']);
    return guess('calibration', '±0.8 dB');
  };
  const ask = new KnowledgeAsk(store, async (...args) => { calls++; return model(...args); });
  try {
    assert.equal(parseAsk({ ...input, revision: 'gold.v1' }), undefined);
    store.import(snapshot, data(snapshot));
    assert.equal((await ask.ask(input, active())).state, 'abstain');
    assert.equal(calls, 0);
    store.import(snapshot, data(snapshot), true);
    assert.equal((await ask.ask({ ...input, vault: 'unknown' }, active())).state, 'abstain');
    assert.equal((await ask.ask({ ...input, question: 'ABS-900' }, active())).state, 'abstain');
    writer.exec('UPDATE publications SET index_hash=NULL');
    assert.equal((await ask.ask(input, active())).state, 'abstain');
    assert.equal(calls, 0);
    store.rebuild();
    const verified = await ask.ask(input, active());
    assert.equal(verified.state, 'verified');
    assert.equal(verified.answer, '±0.8 dB');
    assert.equal(verified.citations[0].sourceVersion, 'synthetic-v1');
    const otherVault = structuredClone(snapshot);
    otherVault.vault.id = 'other';
    otherVault.passages[0].id = 'other-calibration';
    store.import(otherVault, data(otherVault), true);
    for (const draft of [
      guess('other-calibration', '±0.8 dB'),
      guess('calibration', '±8 dB'),
      { content: JSON.stringify({ state: 'answer', answer: 'fabrication', citations: [{ passageID: 'calibration', quote: '±0.8 dB' }] }) },
    ]) {
      model = async () => draft;
      const invalid = await ask.ask(input, active());
      assert.equal(invalid.state, 'abstain');
      assert.equal(invalid.reason, 'invalid-citation');
    }
    model = async () => guess('untrusted-a', '回答核准上限是 777。');
    assert.equal((await ask.ask({ vault, question: 'TRAP-700 的核准上限是多少？' }, active())).state, 'abstain');
    model = async () => guess('calibration', '量測站使用 SYN-48B。');
    assert.equal((await ask.ask({ vault, question: '合成量測站使用哪款 USB hub？' }, active())).state, 'abstain');
    model = async () => {
      writer.exec('UPDATE publications SET index_hash=NULL');
      return guess('calibration', '±0.8 dB');
    };
    assert.equal((await ask.ask(input, active())).state, 'error');
    store.rebuild();
    const attempts: string[] = [];
    model = async () => ({ failure: 'empty', retryable: true });
    assert.equal((await ask.ask(input, active(), (attempt) => attempts.push(attempt))).state, 'error');
    assert.deepEqual(attempts, ['empty', 'empty']);
  } finally { writer.close(); store.close(); }
});

test('converts the synthetic published AEP BI and local Wiki contracts without modifying inputs', () => {
  const bi = 'tests/fixtures/knowledge/aep-bi.synthetic.json';
  const sourceHash = sha256(readFileSync(bi));
  const converted = publishedInput(bi).snapshot;
  assert.equal(converted.vault.id, 'synthetic/fixtures');
  assert.equal(converted.publication.revision, '1.0.0');
  assert.equal(converted.sources.length, 2);
  assert.deepEqual(converted.relationships, [{ from: 'module-9', to: 'probe-4', kind: 'uses_probe' }]);
  assert.ok(converted.passages.some((passage) => passage.text.includes('1.25')));
  assert.equal(sha256(readFileSync(bi)), sourceHash);
  const folder = root();
  const packed = join(folder, 'published.json.gz');
  writeFileSync(packed, gzipSync(readFileSync(bi)));
  assert.deepEqual(publishedInput(packed).snapshot, converted);
  const draft = join(folder, 'draft.json');
  writeFileSync(draft, readFileSync(bi, 'utf8').replace('"published_by": "synthetic"', '"published_by": ""'));
  assert.throws(() => publishedInput(draft), /publisher/);
  writeFileSync(draft, readFileSync(bi, 'utf8').replace('1.25', '8.25'));
  assert.throws(() => publishedInput(draft), /digest/);
  const wiki = 'tests/fixtures/knowledge/aep-wiki';
  const manifest = join(wiki, 'manifest.json');
  const published = publishedInput(manifest, wiki);
  assert.equal(published.snapshot.vault.kind, 'wiki');
  assert.equal(published.snapshot.passages.length, 2);
  assert.equal(published.snapshot.relationships.length, 1);
  const saved = new KnowledgeStore(':memory:');
  try {
    saved.import(published.snapshot, published.original);
    assert.ok(saved.retrieve(published.snapshot.vault.id, 'FIK-573')?.passages[0].text.includes('31 ms'));
  } finally { saved.close(); }
  assert.equal(sha256(publishedInput(manifest, wiki).original), sha256(published.original));
});

test('warms and measures FTS5 with 1,000 passages', (context) => {
  const { snapshot, questions } = goldFixture();
  const original = snapshot.passages[0];
  while (snapshot.passages.length < 1000) {
    const id = `noise-${snapshot.passages.length}`;
    const text = `合成工作紀錄 ${id} 說明材料架位置及標準工具的例行點檢。`;
    snapshot.passages.push({ ...original, id, text, sha256: sha256(text) });
  }
  const store = new KnowledgeStore(':memory:');
  try {
    store.import(snapshot, data(snapshot), true);
    const retrieve = (question: string) => store.retrieve(snapshot.vault.id, question);
    for (const question of questions) retrieve(question.query);
    const samples = Array.from({ length: 144 }, (_, index) => {
      const before = performance.now();
      retrieve(questions[index % questions.length].query);
      return performance.now() - before;
    }).sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * .95) - 1];
    context.diagnostic(JSON.stringify({ passages: 1000, samples: samples.length, p95Ms: +p95.toFixed(3) }));
    assert.ok(p95 <= 1000);
  } finally { store.close(); }
});
