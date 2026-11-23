import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, sha256, snapshotFormat } from '../../../packages/knowledge/src/snapshot.ts';
import type { Snapshot } from '../../../packages/knowledge/src/snapshot.ts';

export const sentinels = {
  row: 'PRIVATE_ROW_VALUE_SENTINEL',
  excerpt: 'PRIVATE_QUOTE_SENTINEL',
  filename: 'PRIVATE_NESTED_NAME_SENTINEL',
};

const at = '2026-01-01T00:00:00Z';
const tagNames = ['tag-a', 'tag-b', 'tag-c'] as const;
const author = 'author-a';

function smallSnapshot(): Snapshot {
  const document = { fields: ['field-x'] };
  const text = `SYN-123 supports operation X. ${sentinels.excerpt}`;
  return {
    format: snapshotFormat, status: 'published', vault: { id: 'repo-a', title: sentinels.row, kind: 'bi' },
    publication: { revision: 'input-a', publishedAt: at, publisher: author },
    schema: { id: 'synthetic', version: '1', document, sha256: sha256(canonical(document)) },
    sources: [{ id: 'source-a', ref: sentinels.row, version: '1' }],
    cards: [
      { id: 'card-a', type: 'kind-x', key: 'key-a', title: sentinels.row, version: '3', fields: { 'field-x': sentinels.row } },
      { id: 'card-b', type: 'kind-x', key: 'key-b', title: 'Card B', version: '2', fields: {} },
    ],
    relationships: [{ from: 'card-a', to: 'card-b', kind: 'references' }],
    passages: [{ id: 'passage-a', sourceId: 'source-a', cardId: 'card-a', locator: '#L2-L4', text, sha256: sha256(text) }],
  };
}

function mirrorDatabase(path: string, snapshot: Snapshot, tag: string, version: number) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA user_version=14;
      CREATE TABLE cards (id TEXT PRIMARY KEY, entity_type TEXT, canonical_key TEXT, name TEXT, version INTEGER);
      CREATE TABLE fields (card_id TEXT, field TEXT, value TEXT, kind TEXT, ref TEXT, by TEXT, at TEXT);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE history (seq INTEGER PRIMARY KEY, card_id TEXT, field TEXT, old TEXT, new TEXT, old_evidence TEXT);
      CREATE TABLE relations (relation_id TEXT PRIMARY KEY, from_card_id TEXT, relation_type TEXT, to_card_id TEXT, status TEXT, origin TEXT);
      CREATE TABLE relation_evidence (evidence_link_id TEXT PRIMARY KEY, relation_id TEXT, basis_card_id TEXT, reference_id TEXT, stance TEXT);
      CREATE TABLE evidence (seq INTEGER PRIMARY KEY, card_id TEXT, field TEXT, source_id TEXT, source_name TEXT,
        locator TEXT, excerpt TEXT, basis TEXT, reference_id TEXT, stance TEXT);
      INSERT INTO meta VALUES ('schema', 'bi.schema/v1.1@5.0.0+synthetic');
    `);
    const insertCard = db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, ?)');
    const insertField = db.prepare('INSERT INTO fields VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertEvidence = db.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertRelation = db.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)');
    const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
    for (const card of snapshot.cards) {
      insertCard.run(card.id, card.type, card.key, card.title, Number(card.version) || 1);
      for (const [field, value] of Object.entries(card.fields)) {
        insertField.run(card.id, field, JSON.stringify(value), 'edit', tag, author, at);
      }
    }
    const first = snapshot.cards[0];
    db.prepare('INSERT INTO history VALUES (1, ?, ?, ?, ?, ?)').run(first.id, 'field-x', 'null', JSON.stringify(sentinels.row), '[]');
    const edge = snapshot.relationships[0] ?? { from: first.id, to: snapshot.cards[1].id, kind: 'references' };
    insertRelation.run('relation-a', edge.from, edge.kind, edge.to, 'confirmed', 'registered');
    db.prepare('INSERT INTO relation_evidence VALUES (?, ?, ?, ?, ?)').run('link-a', 'relation-a', edge.from, 'reference-1', 'supports');
    const evidenceIds = new Map<string, string>();
    for (const [index, passage] of snapshot.passages.entries()) {
      const seq = index + 1;
      const source = sources.get(passage.sourceId)!;
      const locator = passage.locator === '#L2-L4' ? { rev: 1, line_start: 2, line_end: 4 } : passage.locator;
      insertEvidence.run(seq, passage.cardId!, 'field-x', source.id, source.ref, JSON.stringify(locator), passage.text,
        'quote', `reference-${seq}`, 'supports');
      evidenceIds.set(passage.id, `evidence-${seq}`);
    }
    insertEvidence.run(snapshot.passages.length + 1, first.id, 'field-x', 'source-b', 'Source B', '{}', '',
      'quote', 'reference-blank', 'context_only');
    db.exec(`PRAGMA user_version=${version}`);
    if (version === 8) db.exec('DROP TABLE history; DROP TABLE relation_evidence; ALTER TABLE fields DROP COLUMN ref;');
    if (version === 9) db.exec('ALTER TABLE fields DROP COLUMN at; ALTER TABLE evidence DROP COLUMN stance;');
    return evidenceIds;
  } finally { db.close(); }
}

export function syntheticRepository(root: string, options: { snapshot?: Snapshot; republish?: boolean; metadata?: boolean; version?: 8 | 9 } = {}) {
  const snapshot = options.snapshot ?? smallSnapshot();
  const repo = snapshot.vault.id;
  const commits = new Map<string, string>();
  const artifact = (tag: string) => `published/${tag}.sqlite`;
  const json = (file: string, value: unknown) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value) + '\n');
  };
  for (const folder of ['applications/segment-a/profile', 'applications/segment-a/skills', 'applications/segment-a/tools',
    'applications/segment-a/sources/markdown', 'library/kind-x/profile', 'library/kind-x/skills', 'library/kind-x/tools',
    'library/kind-x/sources', 'library/skills', 'library/skill-review', 'cards', 'published', 'schemas']) {
    mkdirSync(join(root, folder), { recursive: true });
  }
  writeFileSync(join(root, 'applications/segment-a/sources/markdown', `${sentinels.filename}.md`), sentinels.row);
  writeFileSync(join(root, 'cards/card-a.md'), sentinels.excerpt);
  writeFileSync(join(root, 'published/empty.sqlite'), '');
  writeFileSync(join(root, 'published/corrupt.sqlite'), sentinels.row);
  if (options.metadata !== false) {
    json('repo.json', { format: 'aep.knowledge.repo/v1', id: repo, type: 'bi', title: snapshot.vault.title });
  }
  let evidenceIds = new Map<string, string>();
  for (const [index, tag] of tagNames.entries()) {
    const seq = index + 1;
    const record = { format: 'aep.knowledge.commit/v1', repo, author, seq, clock: seq,
      created: at, schema: 'bi.schema/v1.1@5.0.0+synthetic', purpose: 'Synthetic commit', kind: 'change', files: [], ops: [] };
    const commit = sha256(canonical(record));
    commits.set(tag, commit);
    json(`commits/${author}/${seq}.json`, { ...record, id: commit });
    json(`tags/${tag}.json`, { format: 'aep.knowledge.tag/v1', name: tag, commit, by: author, at });
    evidenceIds = mirrorDatabase(join(root, artifact(tag)), snapshot, tag, options.version ?? 14);
  }
  const publish = (tag: string, clock: number, seq: number, extras: Record<string, unknown> = {}, by = author) => {
    const path = artifact(tag);
    const bytes = readFileSync(join(root, path));
    json(`publish/${by}/${seq}.json`, {
      format: 'aep.knowledge.publish/v1', repo, author: by, seq, clock, tag, commit: commits.get(tag), at,
      snapshot: { path, sha256: sha256(bytes), bytes: bytes.length }, ...extras,
    });
  };
  publish('tag-a', 4, 1);
  publish('tag-b', 5, 2);
  if (options.republish !== false) publish('tag-a', 6, 3);
  return { repo, commits, json, publish, evidenceIds };
}

export const forecast = '年度展望顯示 2031 年共需 900 台，1.6T 燈具約 300 台，2032 年 1.6T 燈具可達 480 台。';
export const biPluginRepositoryQuote = 'SYN-GAMMA calibration limit is 42 mV.';

export function biPluginRepository(root: string) {
  const snapshot = smallSnapshot();
  snapshot.vault = { id: 'synthetic-bi-export', title: 'Synthetic calibration export', kind: 'bi' };
  snapshot.cards[0] = { ...snapshot.cards[0], title: 'SYN-GAMMA', fields: { 'field-x': '42 mV' } };
  snapshot.sources[0].ref = 'calibration-note.txt';
  snapshot.passages[0] = { ...snapshot.passages[0], text: biPluginRepositoryQuote, sha256: sha256(biPluginRepositoryQuote) };
  const fixture = syntheticRepository(root, { snapshot });
  writeFileSync(join(root, 'REPO.md'), '# Synthetic calibration export\n');
  fixture.json('schemas/synthetic/measurement@1.0.0.json', { schema_id: 'synthetic/measurement', version: '1.0.0',
    types: [{ name: 'Measurement', fields: [{ name: 'setting' }] }] });
  return fixture;
}

export const forecastQuestions = [
  '2032 年市場預估 1.6T 燈具的需求是多少？',
  'What is the market estimate for 1.6T lamp demand in 2032?',
];

export function forecastRepository(root: string) {
  const snapshot = smallSnapshot();
  const add = (id: string, text: string) => {
    const sourceId = 'source-' + id;
    snapshot.cards.push({ id, type: 'kind-x', key: id, title: id, version: '1', fields: {} });
    snapshot.sources.push({ id: sourceId, ref: id, version: '1' });
    snapshot.passages.push({ id, sourceId, cardId: id, locator: '#L1', text, sha256: sha256(text) });
  };
  for (let index = 0; index < 24; index++) {
    add('duplicate-' + index, index % 2
      ? 'Market estimate for 1.6T lamp demand in 2032 is pending.'
      : '2032 年市場預估 1.6T 燈具的需求尚待整理。');
  }
  for (let index = 0; index < 8; index++) {
    add('metadata-' + index, 'name: 2032 市場預估 燈具需求 1.6T lamp demand ' + index);
  }
  add('forecast', forecast);
  return syntheticRepository(root, { snapshot });
}
