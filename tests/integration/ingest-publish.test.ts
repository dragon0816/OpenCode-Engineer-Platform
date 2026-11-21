import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { proposeReview } from '../../apps/adapter/src/http/review.ts';
import { KnowledgeAsk } from '../../packages/knowledge/src/ask.ts';
import type { Candidate } from '../../packages/knowledge/src/ingest.ts';
import { sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { readRepository } from '../../packages/knowledge/src/repository.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { syntheticRepository } from '../fixtures/knowledge/repository.ts';

function folder() {
  mkdirSync('.phase0', { recursive: true });
  return mkdtempSync(resolve('.phase0', 'ingest-'));
}

function candidate(kind: Candidate['vault']['kind'], schema: string, text = 'Synthetic calibration uses amber.'): Candidate {
  return {
    vault: { id: kind, kind, title: 'Calibration' }, schema, allowModel: true,
    sources: [{ id: 'source-a', ref: 'calibration.md', original: text, markdown: text }],
    cards: kind === 'bi' ? [{ id: 'card-a', type: 'procedure', key: 'calibration', title: 'Calibration',
      version: '1', fields: { setting: text } }] : [],
    relationships: [],
    evidence: [{ sourceId: 'source-a', start: 0, end: text.length,
      ...(kind === 'bi' && { cardId: 'card-a', field: 'setting' }) }],
  };
}

function ask(store: KnowledgeStore, vault: string) {
  const service = new KnowledgeAsk(store, async (_question, [passage]) => ({
    content: JSON.stringify({ state: 'answer', citations: [{ passageID: passage.id, quote: passage.text }] }),
  }));
  return service.ask({ vault, question: 'calibration' }, AbortSignal.timeout(1000));
}

function stage(store: KnowledgeStore, id: string, input: Candidate) {
  if (input.vault.kind === 'bi') {
    store.enqueueBi(id, input);
    store.runBi(id);
  } else store.stage(id, input);
}

const child = `
  import { KnowledgeStore } from './packages/knowledge/src/store.ts';
  const [path, point] = process.argv.slice(1);
  const store = new KnowledgeStore(path);
  const result = store.publishReview('run', (actual) => {
    if (point === actual) process.exit(78);
  });
  process.stdout.write(JSON.stringify(result));
  store.close();
`;
const command = (path: string, point = '') => ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', child, path, point];

for (const kind of ['bi', 'wiki'] as const) {
  const fields = kind === 'bi' ? ['setting'] : [];

  test(kind + ' evidence, review decisions, schema conflicts, edit replay and rollback through Ask', async () => {
    const path = join(folder(), 'knowledge.sqlite');
    const store = new KnowledgeStore(path);
    const reader = new KnowledgeStore(path, true);
    try {
      const schema = store.installReviewSchema(kind, 'local', '1', fields);
      const first = candidate(kind, schema.sha256);
      assert.throws(() => store.stage('bad', { ...first, evidence: [] }), /Evidence/);
      stage(store, 'reject', first);
      assert.throws(() => store.publishReview('reject'), /approval/);
      store.decideReview('reject', 0, 'rejected');
      assert.throws(() => store.publishReview('reject'), /approval/);
      assert.equal((await ask(reader, kind)).state, 'abstain');
      stage(store, 'stale', first);
      store.decideReview('stale', 0, 'approved');
      const schema2 = store.installReviewSchema(kind, 'local', '2', fields);
      assert.throws(() => store.publishReview('stale'), /stale/);
      assert.throws(() => store.stage('stale-input', first), /stale/);

      const valid = candidate(kind, schema2.sha256);
      stage(store, 'first', valid);
      store.decideReview('first', 0, 'approved');
      const { revision } = store.publishReview('first');
      {
        const result = await ask(reader, kind);
        assert.equal(result.state, 'verified');
        assert.equal(result.revision, revision);
      }
      const active = reader.snapshot(kind)!;
      assert.throws(() => store.import(active, Buffer.from('synthetic')), /reviewed publication/);
      stage(store, 'conflict', valid);
      store.decideReview('conflict', 0, 'approved');
      const next = candidate(kind, schema2.sha256, 'Synthetic calibration uses green.');
      stage(store, 'second', next);
      const draft = structuredClone(next);
      draft.sources[0].markdown = 'Synthetic calibration uses violet.';
      draft.evidence[0].end = draft.sources[0].markdown.length;
      if (kind === 'bi') draft.cards[0].fields.setting = 'violet';
      store.editReview('second', 0, draft);
      stage(store, 'second', next);
      assert.throws(() => store.decideReview('second', 0, 'approved'), /changed/);
      store.decideReview('second', 1, 'approved');
      const published = store.publishReview('second');
      assert.throws(() => store.publishReview('conflict'), /base has changed/);
      assert.deepEqual(reader.snapshot(kind)?.sources[0], {
        id: 'source-a', ref: 'calibration.md',
        version: sha256(draft.sources[0].markdown), sha256: sha256(next.sources[0].original),
      });
      assert.equal(reader.snapshot(kind)?.publication.parent, revision);
      assert.equal(reader.snapshot(kind, published.revision)?.passages[0].text, draft.sources[0].markdown);
      const answer = await ask(reader, kind);
      assert.equal(answer.state, 'verified');
      assert.equal(answer.revision, published.revision);
      store.rollbackReview('second');
      {
        const result = await ask(reader, kind);
        assert.equal(result.state, 'verified');
        assert.equal(result.revision, revision);
      }
      assert.equal(store.publishReview('second').replay, true);
      {
        const result = await ask(reader, kind);
        assert.equal(result.state, 'verified');
        assert.equal(result.revision, revision);
      }
      assert.equal(store.reconciliation().intents.length, 2);
      if (kind === 'bi') assert.equal(store.reconciliation().effects.length, 5);
    } finally { reader.close(); store.close(); }
  });

  for (const point of ['before-blob', 'mid-commit', 'after-commit']) {
    test(kind + ' abrupt process exit at ' + point + ' and ten competing publisher processes', async () => {
      const path = join(folder(), 'knowledge.sqlite');
      const store = new KnowledgeStore(path);
      const schema = store.installReviewSchema(kind, 'local', '1', fields);
      stage(store, 'run', candidate(kind, schema.sha256));
      store.decideReview('run', 0, 'approved');
      store.close();
      const gone = spawnSync(process.execPath, command(path, point), { encoding: 'utf8' });
      assert.equal(gone.status, 78, gone.stderr);
      const reader = new KnowledgeStore(path, true);
      try {
        const committed = point === 'after-commit';
        assert.equal(reader.overview().length, Number(committed));
        assert.equal((await ask(reader, kind)).state, committed ? 'verified' : 'abstain');
        assert.equal(reader.reconciliation().intents.length, Number(committed));
        const submit = promisify(execFile);
        const results = await Promise.all(Array.from({ length: 10 }, () => submit(process.execPath, command(path))));
        const publications = results.map(({ stdout }) => JSON.parse(stdout));
        assert.equal(publications.filter(({ replay }) => !replay).length, Number(!committed));
        assert.equal(new Set(publications.map(({ revision }) => revision)).size, 1);
        assert.equal((await ask(reader, kind)).state, 'verified');
        assert.equal(reader.reconciliation().intents.length, 1);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(db.prepare('SELECT count(*) AS total FROM publications').get()?.total, 1);
          assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
          assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        } finally { db.close(); }
      } finally { reader.close(); }
    });
  }
}

test('known AEP SQLite versions normalize without modifying source files and unknown versions reject', () => {
  for (const version of [8, 9, 14, 15]) {
    const root = folder();
    const fixture = syntheticRepository(root, { republish: false });
    const path = join(root, 'published', 'tag-b.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=' + version);
    db.exec('CREATE TABLE field_states (card_id TEXT); DELETE FROM relation_evidence;');
    if (version !== 8) db.exec('ALTER TABLE evidence ADD COLUMN assessment TEXT');
    db.close();
    fixture.publish('tag-b', 8, 4);
    if (version === 15) assert.throws(() => readRepository(root), /user_version/);
    else {
      const result = readRepository(root);
      assert.equal(result.snapshot.schema.document.sqliteUserVersion, version);
      assert.equal(result.snapshot.passages.length, 1);
      assert.deepEqual(result.snapshot.repository?.relationEvidence, []);
    }
  }
});

test('BI claims share a lease and a restarted worker fences a stale claimant', () => {
  const path = join(folder(), 'knowledge.sqlite');
  const first = new KnowledgeStore(path);
  const second = new KnowledgeStore(path);
  try {
    const schema = first.installReviewSchema('bi', 'local', '1', ['setting']);
    const input = candidate('bi', schema.sha256);
    first.enqueueBi('run', input);
    const oldLease = first.claimBi('run');
    assert.ok(oldLease);
    assert.equal(second.claimBi('run'), undefined);
    second.runBi('run');
    assert.deepEqual(second.reviews(), []);
    const database = new DatabaseSync(path);
    try { database.prepare('UPDATE ingest_jobs SET expires=0 WHERE id=?').run('run'); }
    finally { database.close(); }
    second.runBi('run');
    assert.throws(() => first.completeBi('run', oldLease), /lease/);
    assert.equal(first.reviews().length, 1);
    assert.equal(first.reconciliation().effects.length, 1);
    assert.equal(first.reconciliation().jobs[0].completed, 1);
    assert.deepEqual(first.reconciliation().intents, []);
    assert.equal(first.overview().length, 0);
  } finally { second.close(); first.close(); }
});

test('Wiki sandbox discard leaves another sandbox and the approved revision intact', () => {
  const store = new KnowledgeStore(':memory:');
  try {
    const schema = store.installReviewSchema('wiki', 'local', '1', []);
    const input = candidate('wiki', schema.sha256);
    store.stage('first', input);
    store.decideReview('first', 0, 'approved');
    const { revision } = store.publishReview('first');
    store.stage('sandbox-a', input);
    store.stage('sandbox-b', input);
    store.discardWiki('sandbox-a', 0);
    assert.throws(() => store.decideReview('sandbox-a', 0, 'approved'), /changed/);
    assert.equal(store.reviews().find(({ id }) => id === 'sandbox-b')?.status, 'pending');
    assert.equal(store.snapshot('wiki')?.publication.revision, revision);
    const comparison = store.compareReview('sandbox-b');
    assert.deepEqual(comparison.previous?.passages, comparison.candidate.passages);
  } finally { store.close(); }
});

test('first rollback survives process death and retains the publication for reactivation', async () => {
  const path = join(folder(), 'knowledge.sqlite');
  const store = new KnowledgeStore(path);
  const schema = store.installReviewSchema('bi', 'local', '1', ['setting']);
  stage(store, 'run', candidate('bi', schema.sha256));
  store.decideReview('run', 0, 'approved');
  const { revision } = store.publishReview('run');
  const rollbackChild = child.slice(0, child.indexOf('  const result')) +
    "store.rollbackReview('run', () => process.exit(78));";
  const args = command(path);
  args[3] = rollbackChild;
  assert.equal(spawnSync(process.execPath, args).status, 78);
  assert.equal(store.snapshot('bi')?.publication.revision, revision);
  store.rollbackReview('run');
  store.close();
  const reopened = new KnowledgeStore(path);
  try {
    assert.deepEqual(await ask(reopened, 'bi'), { state: 'abstain', reason: 'vault-unavailable' });
    assert.ok(reopened.snapshot('bi', revision));
    assert.equal(reopened.reviews()[0].publication, revision);
    assert.equal(reopened.publishReview('run').replay, true);
    assert.equal(reopened.snapshot('bi'), undefined);
    reopened.reactivateReview('run');
    assert.equal((await ask(reopened, 'bi')).state, 'verified');
    assert.equal(reopened.reconciliation().intents.length, 1);
    reopened.rollbackReview('run');
    stage(reopened, 'later', candidate('bi', schema.sha256, 'Synthetic calibration uses green.'));
    reopened.decideReview('later', 0, 'approved');
    const later = reopened.publishReview('later').revision;
    assert.equal(reopened.snapshot('bi')?.publication.revision, later);
    assert.ok(reopened.snapshot('bi', revision));
  } finally { reopened.close(); }
});

for (const point of ['before-blob', 'mid-commit', 'after-commit']) {
  test('incremental publication preserves the parent and replays after ' + point, async () => {
    const path = join(folder(), 'knowledge.sqlite');
    const store = new KnowledgeStore(path);
    const schema = store.installReviewSchema('bi', 'local', '1', ['setting']);
    const seed = candidate('bi', schema.sha256);
    seed.cards = Array.from({ length: 500 }, (_, index) => ({
      ...seed.cards[0], id: 'card-' + index, key: 'card-' + index, fields: { setting: 'amber '.repeat(60) },
    }));
    seed.evidence = seed.cards.map((card) => ({ ...seed.evidence[0], cardId: card.id }));
    assert.ok(Buffer.byteLength(JSON.stringify(seed)) > 128 * 1024);
    store.stage('seed', seed);
    store.decideReview('seed', 0, 'approved');
    const parent = store.publishReview('seed').revision;
    const text = 'Synthetic calibration uses violet. ' + 'z'.repeat(140_000);
    const bytes = Buffer.from(text);
    const hash = sha256(bytes);
    assert.throws(() => store.uploadReviewSource(sha256('wrong'), bytes), /checksum/);
    assert.throws(() => store.uploadReviewSource(hash, Buffer.alloc(1024 * 1024 + 1)), /size/);
    store.uploadReviewSource(hash, bytes);
    const card = { ...seed.cards[0], id: 'new', key: 'new', fields: { setting: 'violet' } };
    const change = { vault: seed.vault, schema: schema.sha256, parent, allowModel: true,
      addCards: [card], updateCards: [{ ...seed.cards[3], fields: { setting: 'violet' } }], removeCards: ['card-2'],
      sources: [{ id: 'upload', ref: 'synthetic.md', sha256: hash }],
      evidence: [card.id, 'card-3', 'card-4'].map((cardId) =>
        ({ sourceId: 'upload', cardId, field: 'setting', start: 0, end: 34 })),
      relationships: [{ from: 'card-1', to: card.id, kind: 'related' }] };
    assert.throws(() => store.stage('bad', { ...change, evidence: [] }), /evidence/i);
    store.stage('run', change);
    assert.throws(() => store.publishReview('run'), /approval/);
    store.stage('stale-change', change);
    store.decideReview('stale-change', 0, 'approved');
    store.decideReview('run', 0, 'approved');
    store.close();
    assert.equal(spawnSync(process.execPath, command(path, point)).status, 78);
    const submit = promisify(execFile);
    const attempts = await Promise.all(Array.from({ length: 10 }, () => submit(process.execPath, command(path))));
    const results = attempts.map(({ stdout }) => JSON.parse(stdout));
    assert.equal(new Set(results.map(({ revision }) => revision)).size, 1);
    assert.equal(results.filter(({ replay }) => !replay).length, point === 'after-commit' ? 0 : 1);
    const reopened = new KnowledgeStore(path);
    try {
      const current = reopened.snapshot('bi')!;
      assert.equal(current.publication.parent, parent);
      assert.equal(current.cards.length, 500);
      assert.ok(current.cards.some(({ id }) => id === 'new'));
      assert.ok(!current.cards.some(({ id }) => id === 'card-2'));
      assert.equal(current.cards.find(({ id }) => id === 'card-3')?.fields.setting, 'violet');
      assert.equal(current.passages.filter(({ cardId }) => cardId === 'card-3').length, 1);
      assert.equal(current.passages.filter(({ cardId }) => cardId === 'card-4').length, 2);
      assert.equal(current.sources.length, 2);
      assert.equal(current.relationships.length, 1);
      assert.equal(reopened.reconciliation().intents.length, 2);
      assert.throws(() => reopened.publishReview('stale-change'), /base has changed/);
      reopened.stage('run', change);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS total FROM publications').get()?.total, 2);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { db.close(); }
    } finally { reopened.close(); }
  });
}

test('explicit proposal checks exact quotes with Ask model permission disabled and never publishes', async () => {
  const store = new KnowledgeStore(':memory:');
  try {
    const schema = store.installReviewSchema('bi', 'local', '1', ['setting']);
    stage(store, 'seed', { ...candidate('bi', schema.sha256), allowModel: false });
    store.decideReview('seed', 0, 'approved');
    const parent = store.publishReview('seed').revision;
    const source = 'Synthetic calibration uses violet.';
    const hash = sha256(source);
    store.uploadReviewSource(hash, Buffer.from(source));
    const input = { action: 'propose', id: 'model', vault: 'bi', parent, schema: schema.sha256, sha256: hash, ref: 'synthetic.md' };
    const signal = AbortSignal.timeout(1000);
    const fake = (quote: string) => async (_prompt: string, payload: unknown) => {
      assert.deepEqual(payload, { source, fields: ['setting'] });
      return { content: JSON.stringify({ title: 'Synthetic Calibration', fields: { setting: { value: 'violet', quote } } }) };
    };
    assert.deepEqual(await proposeReview(store, input, fake('Synthetic calibration uses indigo.'), signal), { rejected: ['setting'] });
    assert.equal(store.reviews().length, 1);
    assert.deepEqual(await proposeReview(store, input, fake(source), signal), { id: 'model' });
    assert.equal(store.reviews()[0].status, 'pending');
    assert.equal(store.compareReview('model').candidate.passages.at(-1)?.text, source);
    assert.throws(() => store.publishReview('model'), /approval/);
    assert.equal(store.snapshot('bi')?.publication.revision, parent);
    assert.equal(store.reconciliation().intents.length, 1);
  } finally { store.close(); }
});
