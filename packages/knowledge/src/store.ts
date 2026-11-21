import { randomUUID } from 'node:crypto';
import { key, materialize, reviewSchema } from './ingest.ts';
import type { Candidate } from './ingest.ts';
import { ingestMigration, jobsMigration } from './ingest-migrations.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Passage } from '../../contracts/src/evidence.ts';
import { evidenceRanker, indexedTerms, matchQuery, normalizedPassage } from './retrieval.ts';
import { canonical, compareRepositoryPublications, sha256, validateSnapshot } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

const schema = `
  CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY, bytes BLOB NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS publications (
    id INTEGER PRIMARY KEY, vault TEXT NOT NULL, revision TEXT NOT NULL, title TEXT NOT NULL,
    kind TEXT NOT NULL, published_at INTEGER NOT NULL, schema_id TEXT NOT NULL, schema_version TEXT NOT NULL,
    manifest_hash TEXT NOT NULL REFERENCES blobs(hash), input_hash TEXT NOT NULL REFERENCES blobs(hash),
    allow_model INTEGER NOT NULL CHECK(allow_model IN (0, 1)), index_hash TEXT,
    UNIQUE(vault, revision)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY, publication INTEGER NOT NULL REFERENCES publications(id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS passages (
    id INTEGER PRIMARY KEY, publication INTEGER NOT NULL REFERENCES publications(id),
    passage TEXT NOT NULL, source TEXT NOT NULL, locator TEXT NOT NULL, hash TEXT NOT NULL REFERENCES blobs(hash),
    UNIQUE(publication, passage)
  ) STRICT;
  CREATE VIRTUAL TABLE IF NOT EXISTS passage_index USING fts5(
    parts, specs, words, singles, publication UNINDEXED, tokenize='unicode61 remove_diacritics 0'
  );
`;

type Publication = {
  id: number; vault: string; revision: string; title: string; kind: 'bi' | 'wiki'; published_at: number;
  schema_id: string; schema_version: string; manifest_hash: string; input_hash: string; allow_model: number;
  index_hash: string | null;
};
type Provenance = Omit<Passage, 'text'> & { sourceId: string; sourceVersion: string; sourceSha256?: string; cardId?: string };
export type Evidence = Provenance & { text: string; provenance: readonly Provenance[] };

// UTF-8 byte ceiling for passage text, a conservative bound for byte-based model tokenizers.
const evidenceByteLimit = 20_000;
const evidenceCountLimit = 5;

export function manifest(snapshot: Snapshot, inputHash: string) {
  return {
    vault: snapshot.vault.id, revision: snapshot.publication.revision, schema: snapshot.schema.sha256,
    snapshot: sha256(canonical(snapshot)), input: inputHash,
    sources: snapshot.sources.map(({ id, ref, version, sha256 }) => ({ id, ref, version, sha256 })),
    cards: snapshot.cards.map(({ id, type, key, version }) => ({ id, type, key, version })),
    relationships: snapshot.relationships,
    passages: snapshot.passages.map(({ id, sourceId, cardId, locator, sha256 }) => ({ id, sourceId, cardId, locator, sha256 })),
  };
}

export class KnowledgeStore {
  private db: DatabaseSync;

  constructor(path: string, readOnly = false) {
    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    try {
      const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version === 0 && !readOnly) {
        this.db.exec('PRAGMA journal_mode=WAL');
        this.transaction(() => this.db.exec(`${schema} PRAGMA user_version=1;`));
      } else if (version !== 1) throw new Error('Unsupported knowledge database schema');
      if (!readOnly) this.transaction(() => this.db.exec(ingestMigration + jobsMigration));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private putBlob(hash: string, value: Uint8Array) {
    this.db.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?)').run(hash, value);
  }

  private blob(hash: string) {
    const row = this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(hash) as { bytes: Uint8Array } | undefined;
    if (!row || sha256(row.bytes) !== hash) throw new Error('Knowledge blob checksum mismatch');
    return Buffer.from(row.bytes);
  }

  private publication(vault: string, revision?: string) {
    return (revision === undefined
      ? this.db.prepare('SELECT p.* FROM vaults v JOIN publications p ON p.id=v.publication WHERE v.id=?').get(vault)
      : this.db.prepare('SELECT * FROM publications WHERE vault=? AND revision=?').get(vault, revision)) as Publication | undefined;
  }

  snapshot(vault: string, revision?: string) {
    const publication = this.publication(vault, revision);
    return publication && this.readSnapshot(publication);
  }

  private readSnapshot(publication: Publication) {
    return validateSnapshot(JSON.parse(this.blob(publication.manifest_hash).toString('utf8')));
  }

  private index(publication: number, hash: string, snapshot: Snapshot) {
    const insertPassage = this.db.prepare('INSERT INTO passages(publication, passage, source, locator, hash) VALUES (?, ?, ?, ?, ?)');
    const insertIndex = this.db.prepare('INSERT INTO passage_index(rowid,parts,specs,words,singles,publication) VALUES (?, ?, ?, ?, ?, ?)');
    for (const passage of snapshot.passages) {
      const bytes = Buffer.from(passage.text);
      this.putBlob(passage.sha256, bytes);
      const { lastInsertRowid } = insertPassage.run(publication, passage.id, passage.sourceId, passage.locator, passage.sha256);
      insertIndex.run(lastInsertRowid, ...indexedTerms(passage.text), publication);
    }
    this.db.prepare('UPDATE publications SET index_hash=? WHERE id=?').run(hash, publication);
  }

  private activate(vault: string, publication: number) {
    this.db.prepare('INSERT INTO vaults VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET publication=excluded.publication').run(vault, publication);
  }

  restoreRepositoryGeneration(vault: string, revision: string) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM review_schema_heads WHERE vault=?').get(vault)) {
        throw new Error('Use review rollback for a managed vault');
      }
      const generation = this.publication(vault, revision);
      if (!generation || generation.index_hash !== generation.manifest_hash || !this.readSnapshot(generation).repository) {
        throw new Error('Repository generation is missing or its index is unavailable');
      }
      this.activate(vault, generation.id);
    });
  }

  import(snapshot: Snapshot, input: Uint8Array, allowModel = false) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM review_schema_heads WHERE vault=?').get(snapshot.vault.id)) {
        throw new Error('This vault requires a reviewed publication');
      }
      return this.writeSnapshot(snapshot, input, allowModel);
    });
  }

  private writeSnapshot(snapshot: Snapshot, input: Uint8Array, allowModel: boolean, reviewed = false, midCommit?: () => void) {
    validateSnapshot(snapshot);
    const bytes = Buffer.from(canonical(snapshot));
    const hash = sha256(bytes);
    const inputHash = sha256(input);
    const { vault, publication, schema } = snapshot;
    const current = this.publication(vault.id);
    if (current && current.kind !== vault.kind) throw new Error('Published vault kind cannot change');
    let activateRepository = false;
    if (snapshot.repository) {
      const previous = current && this.readSnapshot(current).repository;
      const order = previous ? compareRepositoryPublications(snapshot.repository, previous) : 1;
      if (order === 0 && current?.revision !== publication.revision) {
        throw new Error('Repository publication conflicts with the active generation');
      }
      activateRepository = order >= 0;
    }
    const known = this.publication(vault.id, publication.revision);
    if (known) {
      if (known.manifest_hash !== hash || (snapshot.repository && known.input_hash !== inputHash)) {
        throw new Error('Published revision already exists with different content');
      }
      if (allowModel && !known.allow_model) this.db.prepare('UPDATE publications SET allow_model=1 WHERE id=?').run(known.id);
      if (activateRepository && known.id !== current?.id && known.index_hash === known.manifest_hash) this.activate(vault.id, known.id);
      return { state: 'existing', ...manifest(snapshot, known.input_hash) } as const;
    }
    const publishedAt = Date.parse(publication.publishedAt);
    this.putBlob(hash, bytes);
    this.putBlob(inputHash, input);
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO publications(vault,revision,title,kind,published_at,schema_id,schema_version,manifest_hash,input_hash,allow_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(vault.id, publication.revision, vault.title, vault.kind, publishedAt, schema.id, schema.version, hash, inputHash, Number(allowModel));
    const id = Number(lastInsertRowid);
    this.index(id, hash, snapshot);
    const revisionOrder = current ? publication.revision.localeCompare(current.revision, 'en', { numeric: true }) ||
      (publication.revision < current.revision ? -1 : 1) : 0;
    const newer = current && (publishedAt > current.published_at ||
      publishedAt === current.published_at && revisionOrder > 0);
    midCommit?.();
    if (reviewed || (snapshot.repository ? activateRepository : !current || newer)) this.activate(vault.id, id);
    return { state: 'imported', ...manifest(snapshot, inputHash) } as const;
  }

  installReviewSchema(vault: string, id: unknown, version: unknown, fields: unknown) {
    key(vault);
    const schema = reviewSchema(id, version, fields);
    return this.transaction(() => {
      const body = canonical(schema);
      const previous = this.db.prepare('SELECT body FROM review_schemas WHERE vault=? AND version=?').get(vault, schema.version);
      if (previous) {
        const head = this.db.prepare('SELECT version FROM review_schema_heads WHERE vault=?').get(vault);
        if (previous.body !== body || head?.version !== schema.version) throw new Error('Schema version already exists');
        return schema;
      }
      this.db.prepare('INSERT INTO review_schemas VALUES (?, ?, ?)').run(vault, schema.version, body);
      this.db.prepare(`INSERT INTO review_schema_heads VALUES (?, ?)
        ON CONFLICT(vault) DO UPDATE SET version=excluded.version`).run(vault, schema.version);
      return schema;
    });
  }

  private reviewSchema(vault: string): Snapshot['schema'] {
    const row = this.db.prepare(`SELECT s.body FROM review_schema_heads h
      JOIN review_schemas s USING (vault, version) WHERE h.vault=?`).get(vault);
    if (!row) throw new Error('Install a review schema first');
    return JSON.parse(String(row.body));
  }

  private stageCandidate(id: string, input: Candidate) {
    const original = canonical(input);
    const existing = this.db.prepare('SELECT original FROM reviews WHERE id=?').get(key(id));
    if (existing) {
      if (existing.original !== original) throw new Error('Review key already exists with different input');
      return;
    }
    const vault = key(input.vault.id);
    const parent = this.publication(vault);
    if (parent && parent.kind !== input.vault.kind) throw new Error('Vault kind cannot change');
    materialize(input, this.reviewSchema(vault), 'review-' + sha256(id), parent?.revision);
    this.db.prepare('INSERT INTO reviews(id,vault,parent,original,draft) VALUES (?,?,?,?,?)')
      .run(id, vault, parent?.revision ?? null, original, original);
  }

  stage(id: string, input: Candidate) {
    return this.transaction(() => this.stageCandidate(id, input));
  }

  enqueueBi(id: string, input: Candidate) {
    if (input.vault.kind !== 'bi') throw new Error('Expected a BI candidate');
    const payload = canonical(input);
    this.transaction(() => {
      const existing = this.db.prepare('SELECT payload FROM ingest_jobs WHERE id=?').get(key(id));
      if (!existing) materialize(input, this.reviewSchema(key(input.vault.id)), 'review-' + sha256(id));
      this.db.prepare('INSERT OR IGNORE INTO ingest_jobs(id,payload) VALUES (?,?)').run(id, payload);
      if (this.db.prepare('SELECT payload FROM ingest_jobs WHERE id=?').get(id)?.payload !== payload) {
        throw new Error('Job key already exists with different input');
      }
    });
  }

  claimBi(id: string) {
    const lease = randomUUID();
    const now = Date.now();
    const claimed = this.db.prepare(`UPDATE ingest_jobs SET lease=?, expires=?
      WHERE id=? AND completed=0 AND expires<=?`).run(lease, now + 30_000, key(id), now);
    return claimed.changes ? lease : undefined;
  }

  completeBi(id: string, lease: string) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT payload FROM ingest_jobs
        WHERE id=? AND lease=? AND completed=0 AND expires>?`).get(key(id), lease, Date.now());
      if (!row) throw new Error('Job lease is no longer active');
      this.stageCandidate(id, JSON.parse(String(row.payload)));
      this.db.prepare('INSERT INTO ingest_effects VALUES (?,?)').run(id, id);
      this.db.prepare('UPDATE ingest_jobs SET completed=1, lease=NULL, expires=0 WHERE id=?').run(id);
    });
  }

  runBi(id: string) {
    const lease = this.claimBi(id);
    if (lease) this.completeBi(id, lease);
  }

  reviews() {
    return this.db.prepare('SELECT id,vault,parent,edit,status,publication,draft FROM reviews ORDER BY rowid DESC').all();
  }

  reconciliation() {
    return {
      jobs: this.db.prepare('SELECT id,expires,completed FROM ingest_jobs ORDER BY id').all(),
      effects: this.db.prepare('SELECT * FROM ingest_effects ORDER BY job').all(),
      intents: this.db.prepare('SELECT * FROM notification_intents ORDER BY review').all(),
    };
  }

  private review(id: string) {
    const review = this.db.prepare('SELECT * FROM reviews WHERE id=?').get(key(id));
    if (!review) throw new Error('Review does not exist');
    return review;
  }

  compareReview(id: string) {
    const review = this.review(id);
    const vault = String(review.vault);
    const previous = review.parent === null ? null : this.snapshot(vault, String(review.parent));
    const draft = JSON.parse(String(review.draft)) as Candidate;
    const candidate = materialize(draft, this.reviewSchema(vault), 'review-' + sha256(id));
    return {
      previous: previous && { sources: previous.sources, cards: previous.cards, passages: previous.passages, relationships: previous.relationships },
      candidate: { sources: candidate.sources, cards: candidate.cards, passages: candidate.passages, relationships: candidate.relationships },
    };
  }

  editReview(id: string, edit: number, draft: Candidate) {
    this.transaction(() => {
      const review = this.review(id);
      if (review.status !== 'pending' || review.edit !== edit) throw new Error('Review has changed');
      const original = JSON.parse(String(review.original)) as Candidate;
      if (canonical(draft.vault) !== canonical(original.vault) ||
          canonical(draft.sources.map(({ id, ref, original }) => ({ id, ref, original }))) !==
          canonical(original.sources.map(({ id, ref, original }) => ({ id, ref, original })))) {
        throw new Error('Original sources and vault cannot change');
      }
      materialize(draft, this.reviewSchema(String(review.vault)), 'review-' + sha256(id));
      const body = canonical(draft);
      this.db.prepare('INSERT INTO review_edits VALUES (?,?,?)').run(id, edit + 1, body);
      this.db.prepare('UPDATE reviews SET draft=?, edit=edit+1 WHERE id=?').run(body, id);
    });
  }

  decideReview(id: string, edit: number, decision: 'approved' | 'rejected') {
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('Invalid decision');
    const result = this.db.prepare("UPDATE reviews SET status=? WHERE id=? AND edit=? AND status='pending'")
      .run(decision, key(id), edit);
    if (!result.changes) throw new Error('Review has changed');
  }

  discardWiki(id: string, edit: number) {
    this.transaction(() => {
      const review = this.review(id);
      const draft = JSON.parse(String(review.draft)) as Candidate;
      if (draft.vault.kind !== 'wiki' || review.status !== 'pending' || edit !== review.edit) {
        throw new Error('Wiki sandbox has changed');
      }
      this.db.prepare("UPDATE reviews SET status='discarded' WHERE id=?").run(id);
    });
  }

  publishReview(id: string, fault?: (point: 'before-blob' | 'mid-commit' | 'after-commit') => void) {
    const result = this.transaction(() => {
      const review = this.review(id);
      if (review.publication) return { revision: String(review.publication), replay: true };
      if (review.status !== 'approved') throw new Error('Human approval is required');
      const vault = String(review.vault);
      const parent = this.publication(vault)?.revision;
      if ((parent ?? null) !== review.parent) throw new Error('Published base has changed');
      const revision = 'review-' + sha256(id);
      if (this.publication(vault, revision)) throw new Error('Revision already exists');
      const draft = JSON.parse(String(review.draft)) as Candidate;
      const snapshot = materialize(draft, this.reviewSchema(vault), revision, parent);
      fault?.('before-blob');
      this.writeSnapshot(snapshot, Buffer.from(String(review.draft)), draft.allowModel === true,
        true, () => fault?.('mid-commit'));
      this.db.prepare('UPDATE reviews SET publication=? WHERE id=?').run(revision, id);
      this.db.prepare('INSERT INTO notification_intents VALUES (?,?,?)').run(id, vault, revision);
      return { revision, replay: false };
    });
    if (!result.replay) fault?.('after-commit');
    return result;
  }

  rollbackReview(id: string) {
    return this.transaction(() => {
      const review = this.review(id);
      const vault = String(review.vault);
      if (!review.publication || this.publication(vault)?.revision !== review.publication) {
        throw new Error('Review publication is no longer active');
      }
      if (review.parent === null) {
        this.db.prepare('DELETE FROM vaults WHERE id=?').run(vault);
        return;
      }
      const parent = this.publication(vault, String(review.parent));
      if (!parent || parent.index_hash !== parent.manifest_hash) throw new Error('Previous revision is unavailable');
      this.activate(vault, parent.id);
    });
  }

  overview() {
    const publications = this.db.prepare(`
      SELECT p.* FROM vaults v JOIN publications p ON p.id=v.publication ORDER BY p.title, p.vault
    `).all() as unknown as Publication[];
    return publications.map((publication) => {
      const snapshot = this.readSnapshot(publication);
      return { id: publication.vault, kind: publication.kind, title: publication.title, revision: publication.revision,
        schema: publication.schema_id, schemaVersion: publication.schema_version, publishedAt: snapshot.publication.publishedAt,
        cards: snapshot.cards.length, sources: snapshot.sources.length, passages: snapshot.passages.length,
        relationships: snapshot.relationships.length, modelEnabled: Boolean(publication.allow_model),
        ...(snapshot.repository && { tag: snapshot.repository.tag }),
        ready: publication.index_hash === publication.manifest_hash };
    });
  }

  retrieve(vault: string, question: string) {
    const publication = this.publication(vault);
    if (!publication || publication.index_hash !== publication.manifest_hash) return undefined;
    const snapshot = this.readSnapshot(publication);
    const { revision } = publication;
    const query = matchQuery(question);
    const passages: Evidence[] = [];
    if (query) {
      const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
      const byId = new Map(snapshot.passages.map((passage) => [passage.id, passage]));
      const groups = new Map<string, Provenance[]>();
      for (const original of snapshot.passages) {
        const source = sources.get(original.sourceId)!;
        const key = normalizedPassage(original.text);
        const group = groups.get(key) ?? [];
        group.push({ id: original.id, source: source.ref, locator: original.locator, sha256: original.sha256,
          sourceId: source.id, sourceVersion: source.version,
          ...(source.sha256 && { sourceSha256: source.sha256 }), ...(original.cardId && { cardId: original.cardId }) });
        groups.set(key, group);
      }
      const matches = this.db.prepare(`
        SELECT p.passage, p.source, p.locator, p.hash, bm25(passage_index, 12, 8, 3, 1) AS score
        FROM passage_index JOIN passages p ON p.id=passage_index.rowid
        WHERE passage_index MATCH ? AND passage_index.publication=? AND p.publication=?
        ORDER BY p.passage
      `).iterate(query, publication.id, publication.id);
      const candidates = new Map<string, { id: string; score: number }>();
      for (const row of matches) {
        const original = byId.get(String(row.passage));
        if (!original || row.hash !== original.sha256 ||
            row.locator !== original.locator || row.source !== original.sourceId) throw new Error('Indexed evidence does not match the publication');
        const key = normalizedPassage(original.text);
        const score = Number(row.score);
        const existing = candidates.get(key);
        if (!existing || score < existing.score) candidates.set(key, { id: original.id, score });
      }
      const rank = evidenceRanker(question);
      const ranked = [...candidates].map(([key, { id, score }]) =>
        ({ key, id, rank: rank(byId.get(id)!.text, score) }))
        .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : Number(a.id > b.id)));
      let remaining = evidenceByteLimit;
      for (const { key, id } of ranked) {
        const provenance = groups.get(key)!;
        const primary = provenance.find((entry) => entry.id === id)!;
        const size = Buffer.byteLength(byId.get(id)!.text);
        if (size > remaining) continue;
        passages.push({ ...primary, text: this.blob(primary.sha256).toString('utf8'), provenance });
        remaining -= size;
        if (passages.length === evidenceCountLimit) break;
      }
    }
    return { revision, hash: publication.manifest_hash, allowModel: Boolean(publication.allow_model), passages };
  }

  isCurrent(vault: string, revision: string, hash: string) {
    const publication = this.publication(vault);
    return publication?.revision === revision && publication.manifest_hash === hash && publication.index_hash === hash;
  }

  rebuild() {
    return this.transaction(() => {
      const publications = this.db.prepare('SELECT * FROM publications ORDER BY id').all() as unknown as Publication[];
      this.db.exec('DELETE FROM passage_index; DELETE FROM passages;');
      for (const publication of publications) {
        this.blob(publication.input_hash);
        this.index(publication.id, publication.manifest_hash, this.readSnapshot(publication));
      }
      this.db.exec("INSERT INTO passage_index(passage_index) VALUES ('integrity-check')");
      return publications.length;
    });
  }

  backup(path: string) {
    this.db.prepare('VACUUM INTO ?').run(path);
  }
}
