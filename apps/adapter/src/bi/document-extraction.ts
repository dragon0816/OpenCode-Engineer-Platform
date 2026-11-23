import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyKnowledgePath } from '../../../launcher/src/knowledge.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { readApprovedPage } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import { materializeChange, reviewSchema } from '../../../../packages/knowledge/src/ingest.ts';
import type { ChangeSet } from '../../../../packages/knowledge/src/ingest.ts';
import { isLocalAbsoluteFolder, RepositoryFolder } from '../../../../packages/knowledge/src/repository-files.ts';
import { canonical, sha256, string } from '../../../../packages/knowledge/src/snapshot.ts';
import type { Snapshot } from '../../../../packages/knowledge/src/snapshot.ts';
import { stageReviewProposal } from '../http/review.ts';
import { consolidate, modelCandidates, verifyCandidate } from './document-validation.ts';
import type { DocumentCandidate } from './document-validation.ts';
import { documentWorker, DocumentWorkerError } from './document-worker.ts';
import type { Chunk, Plan, Projection, SchemaStructure, WorkerIssue } from './document-worker.ts';

type Knowledge = NonNullable<Runtime['knowledge']>;
type FileKind = 'pdf' | 'html' | 'text';
type Input = { ref: string; bytes: Buffer } | { url: string };
type Source = { ref: string; title?: string; url?: string; fetchedAt?: string; sha256?: string; documentId?: string };
type SchemaTarget = { vault: string; title: string; schema: Snapshot['schema']; install: boolean };
type State = 'converting' | 'extracting' | 'validating' | 'validated' | 'awaiting-review' | 'needs-attention' | 'failed';
type Cause = WorkerIssue | 'link' | 'model' | 'interrupted' | 'base-changed' | 'no-candidates' | 'isolation-unavailable';
export type ExtractionStatus = { id: string; source: Source; schema: string; state: State; completedChunks: number;
  totalChunks: number; candidates: DocumentCandidate[]; issue?: Cause; reviewId?: string; reused?: boolean;
  baseRevision?: string | null; reviewState?: string; vault?: string; title?: string; publication?: string;
  summary?: Counts;
  repository?: Counts & { tag: string; withoutEvidence: number; digestVerified: boolean; sizeVerified: boolean } };
type Counts = { cards: number; sources: number; passages: number; relationships: number };
type RepositoryDraft = Parameters<Knowledge['reviewStore']['stageRepository']>[1];
type Pending = { id: string; receipt: string; draft: ChangeSet | RepositoryDraft };
type StoredStatus = ExtractionStatus & { pending?: Pending };
type BuildOptions = { worker: typeof documentWorker; signal: AbortSignal; title?: string };

export const documentFileLimit = 10 * 1024 * 1024;
const typeForExtension = new Map<string, FileKind>([
  ['.pdf', 'pdf'], ['.html', 'html'], ['.htm', 'html'], ['.txt', 'text'], ['.md', 'text'], ['.markdown', 'text'],
]);
export const biDocumentFile = (name: string) => typeForExtension.get(extname(name).toLowerCase());
const fallback = reviewSchema('document-note', '1', ['content']);
const choiceId = ({ vault, schema }: SchemaTarget) => sha256(canonical([vault, schema.sha256]));
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const counts = (snapshot: Snapshot): Counts => ({ cards: snapshot.cards.length, sources: snapshot.sources.length,
  passages: snapshot.passages.length, relationships: snapshot.relationships.length });
const localTarget = (schema: Snapshot['schema']): SchemaTarget =>
  ({ vault: 'bi-document-' + schema.sha256, title: schema.id, schema, install: true });

class ExtractionError extends Error {
  readonly issue: Cause;
  constructor(issue: Cause) { super(issue); this.issue = issue; }
}

export class DocumentExtraction {
  private db?: DatabaseSync;
  private readonly stop = new AbortController();
  private running?: Promise<void>;
  private readonly path: string;
  private readonly knowledge: Knowledge;
  private readonly origins: () => ReadonlySet<string>;
  private readonly fetchPage: typeof readApprovedPage;
  private readonly model?: () => string | undefined;

  constructor(path: string, knowledge: Knowledge, origins: () => ReadonlySet<string>,
    fetchPage = readApprovedPage, model?: () => string | undefined) {
    this.path = path;
    this.knowledge = knowledge;
    this.origins = origins;
    this.fetchPage = fetchPage;
    this.model = model;
  }

  private database() {
    if (this.db) return this.db;
    verifyKnowledgePath(this.path);
    const db = new DatabaseSync(this.path);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, projection TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS schemas (digest TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT) STRICT;
        CREATE INDEX IF NOT EXISTS run_receipts ON runs(receipt);
        UPDATE runs SET state='failed',status=json_set(status,'$.state','failed','$.issue','interrupted')
          WHERE state IN ('converting','extracting','validating');`);
    } catch (error) { db.close(); throw error; }
    return this.db = db;
  }

  async close() {
    this.stop.abort();
    await this.running;
    this.db?.close();
  }

  busy() { return Boolean(this.running); }

  private targets() {
    const imported = this.database().prepare('SELECT body FROM schemas ORDER BY digest').all()
      .map(({ body }) => localTarget(JSON.parse(String(body))));
    const local = [localTarget(fallback), ...imported];
    const existing = this.knowledge.reviewStore.reviewTargets().map(target => ({ ...target, install: false }));
    return new Map([...local, ...existing].map(target => [choiceId(target), target]));
  }

  choices() {
    return [...this.targets()].filter(([, { schema }]) => (schema.document.fields as string[]).length)
      .map(([id, { vault, title, schema }]) => ({ id, vault, title, schema: schema.id, version: schema.version,
        fields: schema.document.fields as string[], builtin: schema.sha256 === fallback.sha256 }));
  }

  async importSchemas(path: unknown, signal = this.stop.signal, worker = documentWorker) {
    if (typeof path !== 'string' || !isLocalAbsoluteFolder(path)) throw new Error('Choose a local BI repository folder');
    const folder = new RepositoryFolder(path);
    const records: [string, Record<string, unknown>][] = [];
    let total = 0;
    function visit(directory: string, depth: number) {
      for (const entry of folder.list(directory)) {
        const name = directory + '/' + entry.name;
        if (entry.isDirectory() && depth < 3) visit(name, depth + 1);
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const record = folder.json(name);
        total += Buffer.byteLength(JSON.stringify(record));
        if (total > 4 * 1024 * 1024 || records.length >= 64) throw new Error('Schema import limit');
        records.push([name.slice('schemas/'.length), record]);
      }
    }
    visit('schemas', 0);
    const projected = await worker<SchemaStructure[]>(['schema'], json(records), signal);
    signal.throwIfAborted();
    const schemas = new Map<string, Snapshot['schema']>();
    for (const { id, version, fields } of projected) {
      if (!fields.length) continue;
      try {
        const schema = reviewSchema(id, version, fields);
        schemas.set(schema.sha256, schema);
      } catch { /* Leave unsupported definitions out of the catalog. */ }
    }
    if (!schemas.size) throw new Error('No supported schemas');
    const db = this.database();
    const save = db.prepare('INSERT OR IGNORE INTO schemas VALUES (?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const schema of schemas.values()) save.run(schema.sha256, canonical(schema));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { count: schemas.size, choices: this.choices() };
  }

  status(id: string): ExtractionStatus | undefined {
    const row = this.database().prepare('SELECT status FROM runs WHERE id=?').get(id);
    if (!row) return;
    const status = this.withReviewState(String(row.status));
    if (status.vault && status.publication) {
      const snapshot = this.knowledge.reviewStore.snapshot(status.vault, status.publication);
      if (snapshot) status.summary = counts(snapshot);
    }
    return status;
  }

  recent(pluginBuilds = false): ExtractionStatus[] {
    return this.database().prepare(`SELECT status FROM runs WHERE (json_type(status,'$.vault') IS NOT NULL)=?
      ORDER BY rowid DESC LIMIT 12`).all(Number(pluginBuilds))
      .map(({ status }) => this.withReviewState(String(status)));
  }

  private withReviewState(body: string): ExtractionStatus {
    const { pending: _pending, ...status } = JSON.parse(body) as StoredStatus;
    const review = status.reviewId && this.knowledge.reviewStore.reviewReceipt(status.reviewId);
    if (review) status.reviewState = review.publication ? 'published' : review.status;
    if (review && review.publication) status.publication = review.publication;
    return status;
  }

  private save(status: StoredStatus, receipt?: string) {
    this.database().prepare(`INSERT INTO runs VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state,receipt=coalesce(excluded.receipt,runs.receipt)`)
      .run(status.id, JSON.stringify(status), status.state, receipt ?? null);
  }

  submit(id: string) {
    const row = this.database().prepare('SELECT status FROM runs WHERE id=?').get(id);
    if (!row) throw new Error('Unknown BI build');
    const { pending, ...status } = JSON.parse(String(row.status)) as StoredStatus;
    if (status.reviewId) return this.status(id)!;
    if (status.state !== 'validated' || !pending) throw new Error('Validate the BI build first');
    const store = this.knowledge.reviewStore;
    const provenance = { origin: 'owner', sourceKey: pending.receipt } as const;
    if (!store.hasReview(pending.id, pending.draft.vault.id, provenance)) {
      if ('repositorySnapshot' in pending.draft) store.stageRepository(pending.id, pending.draft, provenance);
      else stageReviewProposal(store, pending.id, pending.draft, provenance);
    }
    this.recordReview(status, pending.id, pending.receipt);
    return this.status(id)!;
  }

  private recordReview(status: ExtractionStatus, reviewId: string, receipt: string) {
    for (const candidate of status.candidates) if (candidate.state === 'pass') candidate.state = 'awaiting-review';
    status.reviewId = reviewId;
    status.state = 'awaiting-review';
    this.save(status, receipt);
  }

  importRepository(folder: string, consent: boolean, customTitle?: string) {
    if (this.running || !isLocalAbsoluteFolder(folder)) throw new Error('Choose a local BI repository folder');
    const { snapshot, original, digestVerified, sizeVerified } = this.knowledge.readRepository(folder);
    const title = customTitle ? string(customTitle, 'title', 100).trim() : snapshot.vault.title;
    const vault = 'bi-import-' + sha256(canonical([snapshot.vault.id, customTitle?.trim() ?? '']));
    const store = this.knowledge.reviewStore;
    const current = store.snapshot(vault);
    const parent = current?.publication.revision ?? null;
    const receipt = sha256(canonical([vault, snapshot.publication.revision, sha256(original), consent]));
    const reviewId = 'import-' + sha256(canonical([receipt, parent]));
    const evidenced = new Set(snapshot.passages.map(({ cardId }) => cardId));
    const repository = { ...counts(snapshot), tag: snapshot.repository!.tag, digestVerified, sizeVerified,
      withoutEvidence: snapshot.cards.filter(({ id }) => !evidenced.has(id)).length };
    const status: ExtractionStatus = { id: randomUUID(), source: { ref: snapshot.vault.title }, schema: snapshot.schema.id,
      state: 'validated', completedChunks: 0, totalChunks: 0, candidates: [], vault, title, baseRevision: parent, repository };
    const draft = { vault: { ...snapshot.vault, id: vault, title }, repositorySnapshot: snapshot, allowModel: consent, parent };
    const prior = this.database().prepare('SELECT status FROM runs WHERE receipt=? ORDER BY rowid DESC LIMIT 1').get(receipt);
    if (prior) {
      const previous = this.withReviewState(String(prior.status));
      if ((parent && previous.publication === parent) || (previous.baseRevision === parent &&
          (!previous.reviewId || previous.reviewState === 'pending' || previous.reviewState === 'approved'))) {
        return this.status(previous.id)!;
      }
    }
    this.save({ ...status, pending: { id: reviewId, receipt, draft } }, receipt);
    return this.status(status.id)!;
  }

  start(input: Input, schema: unknown, consent: boolean, options?: BuildOptions) {
    this.stop.signal.throwIfAborted();
    options?.signal.throwIfAborted();
    if (this.running) throw new Error('Extraction already active');
    let target = typeof schema === 'string' ? this.targets().get(schema) : undefined;
    if (!target || !(target.schema.document.fields as string[]).length) throw new Error('Schema unavailable');
    if (options?.title !== undefined) {
      const title = string(options.title, 'title', 100).trim();
      target = { ...target, title, vault: 'bi-build-' + sha256(canonical([title, target.schema.sha256])), install: true };
    }
    const ref = 'url' in input ? this.publicUrl(input.url) : input.ref;
    string(ref, 'source', 2048);
    if ('bytes' in input && (!biDocumentFile(ref) || !input.bytes.length || input.bytes.length > documentFileLimit)) {
      throw new Error('Unsupported input');
    }
    const status: ExtractionStatus = { id: randomUUID(), source: { ref }, schema: target.schema.id, state: 'converting',
      completedChunks: 0, totalChunks: 0, candidates: [], ...(options && { vault: target.vault, title: target.title }) };
    this.save(status);
    this.running = this.execute(input, target, consent, status, options).catch((error: unknown) => {
      status.state = 'failed';
      status.issue = this.stop.signal.aborted || options?.signal.aborted ? 'interrupted' :
        error instanceof DocumentWorkerError || error instanceof ExtractionError ? error.issue :
          error instanceof Error && error.message === 'isolation-unavailable' ? 'isolation-unavailable' : 'invalid';
      this.save(status);
    }).finally(() => { this.running = undefined; });
    return this.status(status.id)!;
  }

  private publicUrl(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Expected a public HTTPS URL');
    url.hash = '';
    return url.href;
  }

  private async convert(input: Input, source: Source, signal: AbortSignal, worker: typeof documentWorker, explicitUrl: boolean) {
    let bytes: Buffer;
    let kind: FileKind;
    let charset = '';
    if ('url' in input) {
      const url = this.publicUrl(input.url);
      const origins = explicitUrl ? new Set([new URL(url).origin]) : this.origins();
      const fetched = await this.fetchPage(url, origins, signal).catch(() => { throw new ExtractionError('link'); });
      source.ref = source.url = fetched.url;
      source.fetchedAt = fetched.fetchedAt;
      bytes = fetched.bytes;
      kind = fetched.type === 'text/html' || fetched.type === 'application/xhtml+xml' ? 'html' : 'text';
      if (kind === 'html' && fetched.charset.toLowerCase() !== 'utf-8') charset = fetched.charset.toLowerCase();
    } else {
      bytes = input.bytes;
      kind = biDocumentFile(input.ref)!;
    }
    source.sha256 = sha256(bytes);
    source.documentId = sha256(canonical(['v1', kind, charset, source.sha256]));
    const db = this.database();
    const existing = db.prepare('SELECT projection FROM documents WHERE id=?').get(source.documentId);
    const projection = existing ? JSON.parse(String(existing.projection)) as Projection :
      await worker<Projection>(['convert', kind, charset], bytes, signal);
    if (projection.sha256 !== source.sha256) throw new ExtractionError('invalid');
    if (!existing) db.prepare('INSERT OR IGNORE INTO documents VALUES (?,?)').run(source.documentId, JSON.stringify(projection));
    source.title = projection.title || source.ref;
    return projection.segments;
  }

  private async extractChunk(prompt: string, fields: string[], segments: Chunk, signal: AbortSignal) {
    const alias = this.model?.();
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      if (attempt) await delay(250 * attempt, undefined, { signal });
      const response = await this.knowledge.propose(prompt, { fields, segments }, signal, alias, undefined, 4096);
      signal.throwIfAborted();
      if ('content' in response) {
        try { return modelCandidates(response.content); }
        catch { /* Retry malformed or truncated JSON with the same request. */ }
      } else if (!response.retryable) break;
    }
    throw new ExtractionError('model');
  }

  private async execute(input: Input, target: SchemaTarget, consent: boolean, status: ExtractionStatus, options?: BuildOptions) {
    const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(12 * 60_000), ...(options ? [options.signal] : [])]);
    const worker = options?.worker ?? documentWorker;
    const segments = await this.convert(input, status.source, signal, worker, Boolean(options));
    signal.throwIfAborted();
    const store = this.knowledge.reviewStore;
    const { vault, schema } = target;
    if (target.install) store.installReviewSchema(vault, schema.id, schema.version, schema.document.fields);
    const base = store.reviewBase(vault);
    if (base.schema.sha256 !== schema.sha256 || base.vault && base.vault.kind !== 'bi') throw new ExtractionError('base-changed');
    status.baseRevision = base.parent;
    const receipt = sha256(canonical([vault, schema.sha256, status.source.documentId, status.source.ref]));
    const reviewId = 'extract-' + sha256(canonical([receipt, base.parent]));
    const previous = this.database().prepare(`SELECT status FROM runs WHERE receipt=? AND id<>?
      ORDER BY rowid DESC LIMIT 1`).get(receipt, status.id);
    const prior = previous && JSON.parse(String(previous.status)) as ExtractionStatus;
    const provenance = { origin: 'owner', sourceKey: receipt } as const;
    const priorId = prior?.reviewId;
    const earlier = priorId && store.reviewReceipt(priorId);
    let reusableReview;
    if (priorId && earlier && (earlier.publication || earlier.parent === base.parent) && store.hasReview(priorId, vault, provenance)) {
      reusableReview = priorId;
    } else if (store.hasReview(reviewId, vault, provenance)) reusableReview = reviewId;
    if (reusableReview || (!options && prior?.state === 'needs-attention' && prior.baseRevision === base.parent)) {
      if (prior) {
        status.completedChunks = prior.completedChunks;
        status.totalChunks = prior.totalChunks;
        status.candidates = prior.candidates;
        status.issue = reusableReview ? undefined : prior.issue;
      }
      if (reusableReview) {
        status.reviewId = reusableReview;
        status.state = 'awaiting-review';
        for (const candidate of status.candidates) if (candidate.state === 'pass') candidate.state = 'awaiting-review';
      } else status.state = 'needs-attention';
      status.reused = true;
      this.save(status, receipt);
      return;
    }
    const plan = await worker<Plan>(['plan'], json(segments), signal);
    status.state = 'extracting';
    status.totalChunks = plan.chunks.length;
    this.save(status);
    const fields = schema.document.fields as string[];
    const partials: ReturnType<typeof verifyCandidate>[] = [];
    for (const chunk of plan.chunks) {
      const extracted = await this.extractChunk(plan.prompt, fields, chunk, signal);
      partials.push(...extracted.map(candidate => verifyCandidate(candidate, chunk, segments, fields, status.source.ref, reviewId)));
      status.completedChunks++;
      this.save(status);
    }
    status.state = 'validating';
    this.save(status);
    const identities = await worker<string[]>(['identities'], json(partials.map(({ name }) => ['record', name])), signal);
    status.candidates = consolidate(partials, identities, fields);
    const publishedFields = new Set(base.cards.map(card => canonical(card.fields)));
    const publishedKeys = new Set(base.cards.filter(({ type }) => type === 'record').map(({ key }) => key));
    for (const candidate of status.candidates) {
      if (candidate.state === 'pass' && (publishedKeys.has(candidate.id) || publishedFields.has(canonical(candidate.fields)))) {
        candidate.state = 'needs-attention';
        candidate.issues.push({ code: 'duplicate' });
      }
    }
    const accepted = status.candidates.filter(({ state }) => state === 'pass');
    if (!accepted.length) {
      status.state = 'needs-attention';
      if (!status.candidates.length) status.issue = 'no-candidates';
      this.save(status, receipt);
      return;
    }
    this.save(status, receipt);
    const current = store.reviewBase(vault);
    if (current.parent !== base.parent || current.schema.sha256 !== schema.sha256) {
      for (const candidate of accepted) {
        candidate.state = 'needs-attention';
        candidate.issues.push({ code: 'base-changed' });
      }
      throw new ExtractionError('base-changed');
    }
    const draft: ChangeSet = {
      vault: base.vault ?? { id: vault, kind: 'bi', title: target.title },
      parent: base.parent, schema: schema.sha256, allowModel: base.vault ? base.allowModel : consent,
      addCards: [], updateCards: [], removeCards: [], sources: [], evidence: [], relationships: [],
    };
    const uploads = new Map<number, string>();
    for (const candidate of accepted) {
      const cardId = 'card-' + candidate.id;
      draft.addCards.push({ id: cardId, key: candidate.id, type: 'record', title: candidate.name, version: '1', fields: candidate.fields });
      for (const [field, { segment, locator, start, quote }] of Object.entries(candidate.evidence)) {
        let sourceId = uploads.get(segment);
        if (!sourceId) {
          sourceId = 'source-' + reviewId + '-' + (segment + 1);
          const bytes = Buffer.from(segments[segment].text);
          const hash = sha256(bytes);
          store.uploadReviewSource(hash, bytes);
          draft.sources.push({ id: sourceId, ref: status.source.ref, sha256: hash, locator });
          uploads.set(segment, sourceId);
        }
        draft.evidence.push({ sourceId, cardId, field, start, end: start + quote.length });
      }
    }
    signal.throwIfAborted();
    // The same materializer runs again inside the review transaction and on publish.
    materializeChange(draft, base.parent ? store.snapshot(vault, base.parent) : undefined, schema,
      'verify-' + status.id, hash => store.reviewSource(hash));
    if (options) {
      status.state = 'validated';
      this.save({ ...status, pending: { id: reviewId, receipt, draft } }, receipt);
    } else {
      stageReviewProposal(store, reviewId, draft, provenance);
      this.recordReview(status, reviewId, receipt);
    }
  }
}
