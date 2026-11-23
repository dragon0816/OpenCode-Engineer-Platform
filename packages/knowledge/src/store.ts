import type { BenchmarkQuestion } from './benchmark.ts';
import { browseSnapshot } from './browse.ts';
import { randomUUID } from 'node:crypto';
import { key, materialize, materializeChange, reviewSchema, sourceUploadLimit } from './ingest.ts';
import type { Candidate, ChangeSet } from './ingest.ts';
import { ingestMigration, jobsMigration } from './ingest-migrations.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Passage } from '../../contracts/src/evidence.ts';
import { evidenceRanker, indexedTerms, matchQuery, normalizedPassage } from './retrieval.ts';
import { canonical, compareRepositoryPublications, digestPattern, string, sha256, validateSnapshot } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import { migrateBiOwnership, recoverBiTelegramSource, reviewProvenanceRow, verifyBiOwnership } from './bi/ownership.ts';
import type { BiProvenance } from './bi/ownership.ts';

const vaultClassificationsVersion = 2;
const biOwnershipVersion = 3;
export const knowledgeSchemaVersion = biOwnershipVersion;

const benchmarksMigration = `
  CREATE TABLE IF NOT EXISTS benchmark_sets (
    vault TEXT NOT NULL, name TEXT NOT NULL, questions TEXT NOT NULL, PRIMARY KEY(vault, name)
  ) STRICT;
`;

const vaultClassificationsMigration = `
  CREATE TABLE vault_classifications (
    vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    classification TEXT NOT NULL DEFAULT 'unclassified' CHECK(classification IN ('unclassified', 'public', 'confidential')),
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

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
  private browser?: { hash: string; view: ReturnType<typeof browseSnapshot> };
  private activeFilter: string;
  private readonly ownsBi: boolean;
  private readonly path: string;

  constructor(path: string, readOnly = false) {
    this.path = path;
    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    try {
      const version = this.version(readOnly);
      this.db.exec('PRAGMA foreign_keys=ON');
      if (!readOnly) {
        if (version === 0) this.db.exec('PRAGMA journal_mode=WAL');
        this.transaction(() => {
          const version = this.version(false);
          if (version === 0) this.db.exec(schema);
          this.db.exec(ingestMigration + jobsMigration + benchmarksMigration);
          if (version < vaultClassificationsVersion) {
            this.db.exec(vaultClassificationsMigration);
            if (this.db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Knowledge foreign keys are invalid');
            this.db.exec(`PRAGMA user_version=${vaultClassificationsVersion}`);
          }
          if (version < biOwnershipVersion) {
            migrateBiOwnership(this.db, path);
            this.db.exec(`PRAGMA user_version=${biOwnershipVersion}`);
          }
          verifyBiOwnership(this.db);
        });
      }
      this.ownsBi = this.version(readOnly) >= biOwnershipVersion;
      this.activeFilter = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='inactive_vaults'").get()
        ? 'NOT EXISTS (SELECT 1 FROM inactive_vaults WHERE vault=v.id)' : '1';
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  private version(readOnly: boolean) {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > knowledgeSchemaVersion) throw new Error('知識資料庫版本比程式新。請使用新版程式或先回退資料。');
    if (version < 0 || (version === 0 && readOnly)) throw new Error('知識資料庫版本無效。');
    return version;
  }

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
      ? this.db.prepare(`SELECT p.* FROM vaults v JOIN publications p ON p.id=v.publication WHERE v.id=? AND ${this.activeFilter}`).get(vault)
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
    this.db.prepare('DELETE FROM inactive_vaults WHERE vault=?').run(vault);
  }

  private managedVault(vault: string) {
    return this.db.prepare(`SELECT 1 FROM review_schema_heads WHERE vault=?
      UNION ALL SELECT 1 FROM reviews WHERE vault=? AND publication IS NOT NULL LIMIT 1`).get(vault, vault);
  }

  restoreRepositoryGeneration(vault: string, revision: string) {
    return this.transaction(() => {
      if (this.managedVault(vault)) {
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
      if (this.managedVault(snapshot.vault.id)) {
        throw new Error('This vault requires a reviewed publication');
      }
      return this.writeSnapshot(snapshot, input, allowModel);
    });
  }

  private writeSnapshot(snapshot: Snapshot, input: Uint8Array, allowModel: boolean, reviewID?: string, midCommit?: () => void) {
    validateSnapshot(snapshot);
    const bytes = Buffer.from(canonical(snapshot));
    const hash = sha256(bytes);
    const inputHash = sha256(input);
    const { vault, publication, schema } = snapshot;
    const current = this.publication(vault.id);
    const registered = this.db.prepare('SELECT p.kind FROM vaults v JOIN publications p ON p.id=v.publication WHERE v.id=?').get(vault.id);
    if (registered && registered.kind !== vault.kind) throw new Error('Published vault kind cannot change');
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
    if (this.ownsBi && vault.kind === 'bi') this.db.prepare("INSERT INTO bi_publication_ownership VALUES (?,'bi',?)")
      .run(id, reviewID ?? null);
    this.index(id, hash, snapshot);
    const revisionOrder = current ? publication.revision.localeCompare(current.revision, 'en', { numeric: true }) ||
      (publication.revision < current.revision ? -1 : 1) : 0;
    const newer = current && (publishedAt > current.published_at ||
      publishedAt === current.published_at && revisionOrder > 0);
    midCommit?.();
    if (reviewID || (snapshot.repository ? activateRepository : !current || newer)) this.activate(vault.id, id);
    return { state: 'imported', ...manifest(snapshot, inputHash) } as const;
  }

  installReviewSchema(vault: string, id: unknown, version: unknown, fields: unknown) {
    key(vault);
    const benchmarksMigration = `
  CREATE TABLE IF NOT EXISTS benchmark_sets (
    vault TEXT NOT NULL, name TEXT NOT NULL, questions TEXT NOT NULL, PRIMARY KEY(vault, name)
  ) STRICT;
`;

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

  private reviewSchema(vault: string, base?: Snapshot): Snapshot['schema'] {
    const row = this.db.prepare(`SELECT s.body FROM review_schema_heads h
      JOIN review_schemas s USING (vault, version) WHERE h.vault=?`).get(vault);
    if (row) return JSON.parse(String(row.body));
    if (base?.vault.kind === 'bi') {
      if (Array.isArray(base.schema.document.fields)) {
        return reviewSchema('local-bi', 'derived', base.schema.document.fields);
      }
      const fields = [...new Set(base.cards.flatMap((card) => Object.keys(card.fields)))].sort();
      return reviewSchema('local-bi', 'derived', fields);
    }
    throw new Error('Install a review schema first');
  }

  uploadReviewSource(hash: string, bytes: Uint8Array) {
    if (bytes.length > sourceUploadLimit || sha256(bytes) !== hash) throw new Error('Invalid source checksum or size');
    string(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 'source', sourceUploadLimit);
    return this.transaction(() => {
      this.putBlob(hash, bytes);
      this.db.prepare('INSERT OR IGNORE INTO review_uploads VALUES (?)').run(hash);
      return { sha256: hash };
    });
  }

  reviewSource(hash: string) {
    if (typeof hash !== 'string' || !digestPattern.test(hash) ||
        !this.db.prepare('SELECT 1 FROM review_uploads WHERE hash=?').get(hash)) throw new Error('Unknown uploaded source');
    return this.blob(hash).toString('utf8');
  }

  reviewBase(vault: string) {
    const base = this.snapshot(key(vault));
    const benchmarksMigration = `
  CREATE TABLE IF NOT EXISTS benchmark_sets (
    vault TEXT NOT NULL, name TEXT NOT NULL, questions TEXT NOT NULL, PRIMARY KEY(vault, name)
  ) STRICT;
`;

const schema = this.reviewSchema(vault, base);
    return { vault: base?.vault, parent: base?.publication.revision ?? null, schema, cards: base?.cards ?? [],
      allowModel: this.publication(vault)?.allow_model === 1 };
  }

  reviewTargets() {
    const titled = new Map(this.db.prepare(`
      SELECT p.vault, p.title FROM vaults v JOIN publications p ON p.id=v.publication
      WHERE ${this.activeFilter} AND p.kind='bi' ORDER BY p.title, p.vault
    `).all().map(({ vault, title }) => [String(vault), String(title)]));
    const heads = this.db.prepare(`SELECT h.vault FROM review_schema_heads h
      WHERE NOT EXISTS (SELECT 1 FROM vaults v WHERE v.id=h.vault) ORDER BY h.vault`).all();
    const targets = new Set([...titled.keys(), ...heads.map(({ vault }) => String(vault))]);
    return [...targets].flatMap((id) => {
      try {
        const base = this.reviewBase(id);
        return [{ vault: id, title: titled.get(id) ?? id, schema: base.schema }];
      } catch { return []; }
    });
  }

  reviewReceipt(id: string) {
    const row = this.db.prepare('SELECT parent,status,publication FROM reviews WHERE id=?').get(key(id));
    return row as { parent: string | null; status: string; publication: string | null } | undefined;
  }

  private reviewSnapshot(input: Candidate | ChangeSet, revision: string, parent?: string) {
    const base = parent && 'parent' in input ? this.snapshot(input.vault.id, parent) : undefined;
    const benchmarksMigration = `
  CREATE TABLE IF NOT EXISTS benchmark_sets (
    vault TEXT NOT NULL, name TEXT NOT NULL, questions TEXT NOT NULL, PRIMARY KEY(vault, name)
  ) STRICT;
`;

const schema = this.reviewSchema(input.vault.id, base);
    return 'parent' in input
      ? materializeChange(input, base, schema, revision, (hash) => this.reviewSource(hash))
      : materialize(input, schema, revision, parent);
  }

  private stageCandidate(id: string, input: Candidate | ChangeSet, provenance: BiProvenance) {
    const original = canonical(input);
    const existing = this.db.prepare('SELECT original FROM reviews WHERE id=?').get(key(id));
    if (existing) {
      if (existing.original !== original) throw new Error('Review key already exists with different input');
      if (this.ownsBi && (provenance.origin === 'telegram' || provenance.runId)) {
        const recorded = this.db.prepare('SELECT origin,source_key,run_id,delivery_destination FROM review_provenance WHERE review_id=?').get(id);
        const expected = reviewProvenanceRow(id, provenance);
        if (recorded?.origin !== expected[2] || recorded?.source_key !== expected[3] ||
            recorded?.run_id !== expected[4] || recorded?.delivery_destination !== expected[5]) {
          throw new Error('Review key belongs to another source');
        }
      }
      return;
    }
    const vault = key(input.vault.id);
    const parent = this.publication(vault);
    if (parent && parent.kind !== input.vault.kind) throw new Error('Vault kind cannot change');
    this.reviewSnapshot(input, 'review-' + sha256(id), parent?.revision);
    this.db.prepare('INSERT INTO reviews(id,vault,parent,original,draft) VALUES (?,?,?,?,?)')
      .run(id, vault, parent?.revision ?? null, original, original);
    if (this.ownsBi && input.vault.kind === 'bi') this.db.prepare('INSERT INTO review_provenance VALUES (?,?,?,?,?,?)')
      .run(...reviewProvenanceRow(id, provenance));
  }

  stage(id: string, input: Candidate | ChangeSet, provenance: BiProvenance = { origin: 'owner' }) {
    return this.transaction(() => this.stageCandidate(id, input, provenance));
  }

  enqueueBi(id: string, input: Candidate, origin: BiProvenance['origin'] = 'owner', workId?: string) {
    if (input.vault.kind !== 'bi') throw new Error('Expected a BI candidate');
    const payload = canonical(input);
    this.transaction(() => {
      const existing = this.db.prepare('SELECT payload FROM ingest_jobs WHERE id=?').get(key(id));
      if (!existing) materialize(input, this.reviewSchema(key(input.vault.id)), 'review-' + sha256(id));
      const insert = this.db.prepare('INSERT OR IGNORE INTO ingest_jobs(id,payload) VALUES (?,?)').run(id, payload);
      if (insert.changes && this.ownsBi) this.db.prepare("INSERT INTO bi_job_ownership VALUES (?,'bi',?,?)").run(id, workId ?? null, origin);
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

  completeBi(id: string, lease: string, source?: BiProvenance) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT payload FROM ingest_jobs
        WHERE id=? AND lease=? AND completed=0 AND expires>?`).get(key(id), lease, Date.now());
      if (!row) throw new Error('Job lease is no longer active');
      const saved = this.ownsBi ? this.db.prepare('SELECT origin FROM bi_job_ownership WHERE job_id=?').get(id)?.origin : 'legacy';
      if (typeof saved !== 'string') throw new Error('BI job ownership is missing');
      const delegated = saved === 'owner' && source?.origin === 'owner' && source.runId &&
        source.sourceKey === id && id === 'delegation-' + source.runId;
      const provenance = saved === 'telegram' ? source ?? recoverBiTelegramSource(this.path, id) :
        delegated ? source : { origin: saved as BiProvenance['origin'] };
      if (!provenance || (saved === 'telegram' && (provenance.origin !== 'telegram' || provenance.sourceKey !== id))) {
        throw new Error('BI job source is unavailable');
      }
      this.stageCandidate(id, JSON.parse(String(row.payload)), provenance);
      this.db.prepare('INSERT INTO ingest_effects VALUES (?,?)').run(id, id);
      this.db.prepare('UPDATE ingest_jobs SET completed=1, lease=NULL, expires=0 WHERE id=?').run(id);
    });
  }

  runBi(id: string, source?: BiProvenance) {
    const lease = this.claimBi(id);
    if (lease) this.completeBi(id, lease, source);
  }

  biCompleted(id: string) {
    return this.db.prepare('SELECT completed FROM ingest_jobs WHERE id=?').get(key(id))?.completed === 1;
  }

  pendingBi(now = Date.now()) {
    return this.db.prepare(`SELECT j.id, j.expires, o.work_id AS workId FROM ingest_jobs j
      LEFT JOIN bi_job_ownership o ON o.job_id=j.id WHERE j.completed=0 AND j.expires<=? ORDER BY j.id`).all(now);
  }

  canRunBi(id: string, now = Date.now()) {
    return !this.db.prepare('SELECT 1 FROM ingest_jobs WHERE id=? AND completed=0 AND expires>?').get(key(id), now);
  }

  hasReview(id: string, vault: string, provenance?: BiProvenance) {
    if (!this.db.prepare('SELECT 1 FROM reviews WHERE id=? AND vault=?').get(key(id), key(vault))) return false;
    if (this.ownsBi && provenance?.origin === 'telegram') {
      const existing = this.db.prepare('SELECT source_key,delivery_destination FROM review_provenance WHERE review_id=?').get(id);
      const expected = reviewProvenanceRow(id, provenance);
      return existing?.source_key === expected[3] && existing?.delivery_destination === expected[5];
    }
    if (this.ownsBi && provenance?.sourceKey) {
      const owner = this.db.prepare('SELECT origin,source_key,run_id FROM review_provenance WHERE review_id=?').get(id);
      return owner?.origin === provenance.origin && owner.source_key === provenance.sourceKey && owner.run_id === (provenance.runId ?? null);
    }
    return true;
  }

  biStatus() {
    return this.db.prepare(`SELECT j.id,j.expires,j.completed,r.status AS review_status
      FROM ingest_jobs j LEFT JOIN ingest_effects e ON e.job=j.id
      LEFT JOIN reviews r ON r.id=e.review ORDER BY j.id`).all();
  }

  reconcileBi() {
    const due = this.db.prepare('SELECT id FROM ingest_jobs WHERE completed=0 AND expires<=? ORDER BY id').all(Date.now());
    for (const row of due) {
      try { this.runBi(String(row.id)); }
      catch { /* Retain the job and lease for inspection and retry. */ }
    }
  }

  reviews() {
    const provenance = this.ownsBi ? `LEFT JOIN review_provenance AS owner ON owner.review_id=r.id` : '';
    const source = this.ownsBi ? `,owner.agent_id AS agentId,owner.origin AS origin,
      CASE WHEN owner.origin='telegram' OR owner.run_id IS NOT NULL THEN 'BI 資料處理' END AS agentSource` : '';
    return this.db.prepare(`SELECT r.id,r.vault,r.parent,r.edit,r.status,r.publication,r.draft,
      p.revision=r.publication AND i.vault IS NULL AS active,
      p.revision=r.publication AND i.vault IS NOT NULL AS inactive ${source}
      FROM reviews r LEFT JOIN vaults v ON v.id=r.vault LEFT JOIN publications p ON p.id=v.publication
      LEFT JOIN inactive_vaults i ON i.vault=v.id ${provenance} ORDER BY r.rowid DESC`).all();
  }

  reconciliation() {
    return {
      jobs: this.db.prepare('SELECT id,expires,completed FROM ingest_jobs ORDER BY id').all(),
      effects: this.db.prepare('SELECT * FROM ingest_effects ORDER BY job').all(),
      intents: this.publicationIntents(),
    };
  }

  publicationIntents() {
    return this.db.prepare(this.ownsBi ? `SELECT n.*,p.delivery_destination AS destination,p.source_key AS sourceKey,p.origin
      FROM notification_intents n LEFT JOIN review_provenance p ON p.review_id=n.review ORDER BY n.review` :
      'SELECT * FROM notification_intents ORDER BY review').all();
  }

  publicationNotice(reviewId: string) {
    return this.db.prepare('SELECT review FROM notification_intents WHERE review=?').get(reviewId) !== undefined;
  }

  private review(id: string) {
    const review = this.db.prepare('SELECT * FROM reviews WHERE id=?').get(key(id));
    if (!review) throw new Error('Review does not exist');
    return review;
  }

  reviewStatus(id: string) {
    const row = this.db.prepare('SELECT id,vault,status,edit,publication FROM reviews WHERE id=?').get(key(id));
    return row && { id: row.id, vault: row.vault, status: row.status, edit: row.edit, publication: row.publication };
  }

  compareReview(id: string) {
    const review = this.review(id);
    const vault = String(review.vault);
    const previous = review.parent === null ? null : this.snapshot(vault, String(review.parent));
    const draft = JSON.parse(String(review.draft)) as Candidate | ChangeSet;
    const candidate = this.reviewSnapshot(draft, 'review-' + sha256(id), previous?.publication.revision);
    return {
      previous: previous && { sources: previous.sources, cards: previous.cards, passages: previous.passages, relationships: previous.relationships },
      candidate: { sources: candidate.sources, cards: candidate.cards, passages: candidate.passages, relationships: candidate.relationships },
    };
  }

  editReview(id: string, edit: number, draft: Candidate | ChangeSet) {
    this.transaction(() => {
      const review = this.review(id);
      if (review.status !== 'pending' || review.edit !== edit) throw new Error('Review has changed');
      const original = JSON.parse(String(review.original)) as Candidate | ChangeSet;
      if ('parent' in original !== ('parent' in draft)) throw new Error('Draft format cannot change');
      const sourceIdentity = (input: Candidate | ChangeSet) => 'parent' in input
        ? { parent: input.parent, sources: input.sources }
        : input.sources.map(({ id, ref, original, locator }) => ({ id, ref, original, ...(locator !== undefined && { locator }) }));
      if (canonical(draft.vault) !== canonical(original.vault) ||
          canonical(sourceIdentity(draft)) !== canonical(sourceIdentity(original))) {
        throw new Error('Original sources and vault cannot change');
      }
      this.reviewSnapshot(draft, 'review-' + sha256(id), review.parent === null ? undefined : String(review.parent));
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
      const draft = JSON.parse(String(review.draft)) as Candidate | ChangeSet;
      const snapshot = this.reviewSnapshot(draft, revision, parent);
      fault?.('before-blob');
      this.writeSnapshot(snapshot, Buffer.from(String(review.draft)), draft.allowModel === true,
        id, () => fault?.('mid-commit'));
      this.db.prepare('UPDATE reviews SET publication=? WHERE id=?').run(revision, id);
      this.db.prepare('INSERT INTO notification_intents VALUES (?,?,?)').run(id, vault, revision);
      return { revision, replay: false };
    });
    if (!result.replay) fault?.('after-commit');
    return result;
  }

  reactivateReview(id: string) {
    this.transaction(() => {
      const review = this.review(id);
      const vault = String(review.vault);
      const publication = this.db.prepare(`SELECT p.* FROM inactive_vaults i JOIN vaults v ON v.id=i.vault
        JOIN publications p ON p.id=v.publication WHERE v.id=?`).get(vault) as Publication | undefined;
      if (!publication || publication.revision !== review.publication || publication.index_hash !== publication.manifest_hash ||
          this.readSnapshot(publication).schema.sha256 !== this.reviewSchema(vault, this.readSnapshot(publication)).sha256) {
        throw new Error('Review cannot be reactivated');
      }
      this.activate(vault, publication.id);
    });
  }

  rollbackReview(id: string, beforeCommit?: () => void) {
    return this.transaction(() => {
      const review = this.review(id);
      const vault = String(review.vault);
      if (!review.publication || this.publication(vault)?.revision !== review.publication) {
        throw new Error('Review publication is no longer active');
      }
      if (review.parent === null) {
        this.db.prepare('INSERT INTO inactive_vaults VALUES (?)').run(vault);
        beforeCommit?.();
        return;
      }
      const parent = this.publication(vault, String(review.parent));
      if (!parent || parent.index_hash !== parent.manifest_hash) throw new Error('Previous revision is unavailable');
      this.activate(vault, parent.id);
      beforeCommit?.();
    });
  }

  overview() {
    const publications = this.db.prepare(`
      SELECT p.* FROM vaults v JOIN publications p ON p.id=v.publication WHERE ${this.activeFilter} ORDER BY p.title, p.vault
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

  vaultClassification(vault: string) {
    if (!this.publication(vault)) return;
    const row = this.db.prepare('SELECT classification,updated_at AS revision FROM vault_classifications WHERE vault_id=?').get(vault);
    return { label: (row?.classification ?? 'unclassified') as 'public' | 'confidential' | 'unclassified', revision: Number(row?.revision ?? 0) };
  }

  classifyVault(vault: string, revision: string, label: 'public' | 'confidential' | 'unclassified') {
    return this.transaction(() => {
      if (this.publication(vault)?.revision !== revision) return 'changed';
      const current = this.vaultClassification(vault);
      if (current?.label === 'confidential' && label !== 'confidential') return 'confidential';
      if (current?.label !== label) this.db.prepare('INSERT OR REPLACE INTO vault_classifications VALUES (?,?,?)')
        .run(vault, label, Math.max(Date.now(), (current?.revision ?? 0) + 1));
      return 'saved';
    });
  }

  externalCitation(vault: string, revision: string, passageId: string) {
    const publication = this.publication(vault);
    if (!publication || !this.isCurrent(vault, revision, publication.manifest_hash, true)) return;
    const snapshot = this.readSnapshot(publication);
    const passage = snapshot.passages.find(({ id }) => id === passageId);
    const source = passage && snapshot.sources.find(({ id }) => id === passage.sourceId);
    if (!passage || !source?.sha256) return;
    const bytes = this.blob(passage.sha256);
    if (sha256(bytes) !== passage.sha256 || sha256(passage.text) !== passage.sha256) return;
    return { bytes, sha256: passage.sha256, publicationHash: publication.manifest_hash,
      sourceId: source.id, sourceVersion: source.version, sourceHash: source.sha256 };
  }

  benchmarkSets(vault: string) {
    if (!this.publication(vault)) return;
    return this.db.prepare('SELECT name, questions FROM benchmark_sets WHERE vault=? ORDER BY name').all(vault)
      .map(({ name, questions }) => ({ name: String(name), questions: JSON.parse(String(questions)) as BenchmarkQuestion[], builtIn: false }));
  }

  saveBenchmark(vault: string, name: string, questions: BenchmarkQuestion[] | null) {
    return this.transaction(() => {
      if (!this.publication(vault)) throw new Error('Vault unavailable');
      if (questions === null) this.db.prepare('DELETE FROM benchmark_sets WHERE vault=? AND name=?').run(vault, name);
      else this.db.prepare('INSERT OR REPLACE INTO benchmark_sets VALUES (?, ?, ?)').run(vault, name, JSON.stringify(questions));
    });
  }

  setDemo(snapshot: Snapshot, load: boolean, allowModel = false) {
    return this.transaction(() => {
      const vault = snapshot.vault.id;
      const bytes = Buffer.from(canonical(snapshot));
      const registered = this.db.prepare('SELECT p.* FROM vaults v JOIN publications p ON p.id=v.publication WHERE v.id=?')
        .get(vault) as Publication | undefined;
      if (registered && registered.manifest_hash !== sha256(bytes)) throw new Error('Demo vault collision');
      if (load && registered) {
        this.db.prepare('UPDATE publications SET allow_model=? WHERE id=?').run(Number(allowModel), registered.id);
        this.activate(vault, registered.id);
      } else if (load) this.writeSnapshot(snapshot, bytes, allowModel);
      else if (registered) this.db.prepare('INSERT OR IGNORE INTO inactive_vaults VALUES (?)').run(vault);
    });
  }

  browse(vault: string, input: Record<string, unknown>) {
    const publication = this.publication(vault);
    if (!publication) return undefined;
    if (this.browser?.hash !== publication.manifest_hash) {
      this.browser = { hash: publication.manifest_hash, view: browseSnapshot(this.readSnapshot(publication)) };
    }
    const { view } = this.browser;
    if (typeof input.card === 'string') {
      const detail = view.detail(input.card);
      if (!detail) return undefined;
      const revisions = this.db.prepare('SELECT revision, published_at FROM publications WHERE vault=? ORDER BY published_at DESC LIMIT 50').all(vault);
      return { ...detail, revisions };
    }
    if (typeof input.query === 'string') {
      const query = matchQuery(input.query);
      const ready = publication.index_hash === publication.manifest_hash;
      const matches = query && ready ? this.db.prepare(`
        SELECT p.passage FROM passage_index JOIN passages p ON p.id=passage_index.rowid
        WHERE passage_index MATCH ? AND p.publication=?
        ORDER BY bm25(passage_index, 12, 8, 3, 1), p.passage LIMIT 25
      `).all(query, publication.id) : [];
      return { ready, passages: matches.map(({ passage }) => view.describePassage(String(passage))) };
    }
    return view.list(input);
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

  isCurrent(vault: string, revision: string, hash: string, requireModel = false) {
    const publication = this.publication(vault);
    return publication?.revision === revision && publication.manifest_hash === hash && publication.index_hash === hash &&
      (!requireModel || publication.allow_model === 1);
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
