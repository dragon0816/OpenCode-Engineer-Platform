import { DatabaseSync } from 'node:sqlite';
import type { Passage } from '../../contracts/src/evidence.ts';
import { indexedTerms, matchQuery } from './retrieval.ts';
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
export type Evidence = Passage & { sourceId: string; sourceVersion: string; sourceSha256?: string; cardId?: string };

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
      const generation = this.publication(vault, revision);
      if (!generation || generation.index_hash !== generation.manifest_hash || !this.readSnapshot(generation).repository) {
        throw new Error('Repository generation is missing or its index is unavailable');
      }
      this.activate(vault, generation.id);
    });
  }

  import(snapshot: Snapshot, input: Uint8Array, allowModel = false) {
    validateSnapshot(snapshot);
    const bytes = Buffer.from(canonical(snapshot));
    const hash = sha256(bytes);
    const inputHash = sha256(input);
    const { vault, publication, schema } = snapshot;
    return this.transaction(() => {
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
      if (snapshot.repository ? activateRepository : !current || newer) this.activate(vault.id, id);
      return { state: 'imported', ...manifest(snapshot, inputHash) } as const;
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
      const selected = this.db.prepare(`
        SELECT p.passage, p.source, p.locator, p.hash
        FROM passage_index JOIN passages p ON p.id=passage_index.rowid
        WHERE passage_index MATCH ? AND passage_index.publication=? AND p.publication=?
        ORDER BY bm25(passage_index, 12, 8, 3, 1), p.passage LIMIT 5
      `).all(query, publication.id, publication.id) as { passage: string; source: string; locator: string; hash: string }[];
      for (const row of selected) {
        const original = byId.get(row.passage);
        const source = sources.get(row.source);
        if (!original || !source || row.hash !== original.sha256 ||
            row.locator !== original.locator || row.source !== original.sourceId) throw new Error('Indexed evidence does not match the publication');
        passages.push({ id: row.passage, source: source.ref, locator: row.locator, sha256: row.hash,
          text: this.blob(row.hash).toString('utf8'), sourceId: row.source, sourceVersion: source.version,
          ...(source.sha256 && { sourceSha256: source.sha256 }), ...(original.cardId && { cardId: original.cardId }) });
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
