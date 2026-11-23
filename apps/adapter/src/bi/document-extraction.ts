import { randomUUID } from 'node:crypto';
import { dirname, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyKnowledgePath } from '../../../launcher/src/knowledge.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { readApprovedPage } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import type { BiProvenance } from '../../../../packages/knowledge/src/bi/ownership.ts';
import { materializeChange, reviewSchema } from '../../../../packages/knowledge/src/ingest.ts';
import type { ChangeSet } from '../../../../packages/knowledge/src/ingest.ts';
import { isLocalAbsoluteFolder, RepositoryFolder } from '../../../../packages/knowledge/src/repository-files.ts';
import { canonical, sha256, string } from '../../../../packages/knowledge/src/snapshot.ts';
import type { Snapshot } from '../../../../packages/knowledge/src/snapshot.ts';
import { stageReviewProposal } from '../http/review.ts';
import { defaultOcr, documentFileLimit, documentOcr, ocrLocator } from './document-ocr.ts';
import type { OcrOptions } from './document-ocr.ts';
import { consolidate, modelCandidates, verifyCandidate } from './document-validation.ts';
import type { DocumentCandidate } from './document-validation.ts';
import { documentWorker, DocumentWorkerError } from './document-worker.ts';
import type { Chunk, PageStatus, Plan, Projection, SchemaStructure, WorkerIssue } from './document-worker.ts';
import { defaults, stageSettings, type PipelineMode, type PipelineSettings } from './pipeline-settings.ts';
import { runBenchmark, type BenchmarkReport } from './pipeline-benchmark.ts';
import { BiWorkspaces } from './workspaces.ts';
import { readWorkingRepository } from './working-repository.ts';

type Knowledge = NonNullable<Runtime['knowledge']>;
type FileKind = 'pdf' | 'html' | 'text' | 'image';
export type DocumentInput = { ref: string; bytes: Buffer } | { url: string };
type Source = { ref: string; title?: string; url?: string; fetchedAt?: string; sha256?: string; documentId?: string };
type SchemaTarget = { vault: string; title: string; schema: Snapshot['schema']; install: boolean };
type State = 'converting' | 'converted' | 'extracting' | 'validating' | 'ingested' | 'testing' | 'validated' |
  'awaiting-review' | 'needs-attention' | 'failed';
type Cause = WorkerIssue | 'link' | 'model' | 'interrupted' | 'base-changed' | 'no-candidates' | 'isolation-unavailable';
export type ExtractionStatus = { id: string; source: Source; schema: string; state: State; completedChunks: number;
  totalChunks: number; candidates: DocumentCandidate[]; pages?: PageStatus[]; issue?: Cause; reviewId?: string; reused?: boolean;
  baseRevision?: string | null; reviewState?: string; vault?: string; title?: string; publication?: string;
  summary?: Counts;
  mode?: PipelineMode; stage?: 'convert' | 'ingest' | 'testing'; benchmark?: BenchmarkReport;
  scheduled?: boolean;
  events?: { state: State; at: string }[];
  conversion?: { segments: number; preview: Projection['segments'] };
  repository?: Counts & { tag: string; withoutEvidence: number; digestVerified: boolean; sizeVerified: boolean } };
type Counts = { cards: number; sources: number; passages: number; relationships: number };
type RepositoryDraft = Parameters<Knowledge['reviewStore']['stageRepository']>[1];
type Pending = { id: string; receipt: string; draft: ChangeSet | RepositoryDraft; workspaceVersion?: number };
type ScheduledReview = { id: string; provenance: BiProvenance };
type Checkpoint = { target: SchemaTarget; consent: boolean; settings: PipelineSettings; workingVersion?: number; scheduled?: ScheduledReview };
type StoredStatus = ExtractionStatus & { pending?: Pending; checkpoint?: Checkpoint };
type BuildOptions = { worker: typeof documentWorker; signal: AbortSignal; title?: string; mode?: PipelineMode;
  scheduled?: ScheduledReview; ocr?: OcrOptions };

export { documentFileLimit };
const typeForExtension = new Map<string, FileKind>([
  ['.pdf', 'pdf'], ['.html', 'html'], ['.htm', 'html'], ['.txt', 'text'], ['.md', 'text'], ['.markdown', 'text'], ['.csv', 'text'],
  ['.png', 'image'], ['.jpeg', 'image'], ['.jpg', 'image'],
]);
export const biDocumentFile = (name: string) => typeForExtension.get(extname(name).toLowerCase());
const fallback = reviewSchema('document-note', '1', ['content']);
const choiceId = ({ vault, schema }: SchemaTarget) => sha256(canonical([vault, schema.sha256]));
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const counts = (snapshot: Snapshot): Counts => ({ cards: snapshot.cards.length, sources: snapshot.sources.length,
  passages: snapshot.passages.length, relationships: snapshot.relationships.length });
const withoutEvidence = (snapshot: Snapshot) => {
  const evidenced = new Set(snapshot.passages.map(({ cardId }) => cardId));
  return snapshot.cards.filter(({ id }) => !evidenced.has(id)).length;
};
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
  private readonly workspaces: BiWorkspaces;

  constructor(path: string, knowledge: Knowledge, origins: () => ReadonlySet<string>,
    fetchPage = readApprovedPage, model?: () => string | undefined, pluginRoot?: string) {
    this.path = path;
    this.knowledge = knowledge;
    this.origins = origins;
    this.fetchPage = fetchPage;
    this.model = model;
    this.workspaces = new BiWorkspaces(pluginRoot ?? dirname(path));
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
          WHERE state IN ('converting','extracting','validating','testing');`);
    } catch (error) { db.close(); throw error; }
    return this.db = db;
  }

  async close() {
    this.stop.abort();
    await this.running;
    this.db?.close();
    this.workspaces.close();
  }

  busy() { return Boolean(this.running); }

  scheduleTarget(vault: string) {
    return this.choices(true).find(choice => choice.vault === vault && !choice.vault.startsWith('bi-document-'));
  }

  async runScheduled(input: DocumentInput, vault: string, review: ScheduledReview, options: BuildOptions, authorized: () => void) {
    const target = this.scheduleTarget(vault);
    if (!target) throw new Error('BI schedule target is unavailable');
    const status = this.start(input, target.id, false, { ...options, scheduled: review });
    await this.running;
    options.signal.throwIfAborted();
    this.stop.signal.throwIfAborted();
    authorized();
    const outcome = this.status(status.id);
    if (outcome?.state === 'validated') return this.submit(status.id, review).reviewId;
    return outcome?.reviewId;
  }

  private targets(includeWorkspaces = true) {
    const imported = this.database().prepare('SELECT body FROM schemas ORDER BY digest').all()
      .map(({ body }) => localTarget(JSON.parse(String(body))));
    const local = [localTarget(fallback), ...imported];
    const existing = this.knowledge.reviewStore.reviewTargets().map(target => ({ ...target, install: false }));
    const workspace = includeWorkspaces ? this.workspaces.list().map(({ id, title, schema }) =>
      ({ vault: id, title, schema, install: true })) : [];
    return new Map([...local, ...existing, ...workspace].map(target => [choiceId(target), target]));
  }

  choices(includeWorkspaces = false) {
    const workspaces = new Set(includeWorkspaces ? this.workspaces.list().map(({ id }) => id) : []);
    return [...this.targets(includeWorkspaces)].filter(([, { schema }]) => (schema.document.fields as string[]).length)
      .map(([id, { vault, title, schema }]) => ({ id, vault, title, schema: schema.id, version: schema.version,
        fields: schema.document.fields as string[], builtin: schema.sha256 === fallback.sha256 && vault.startsWith('bi-document-'),
        working: workspaces.has(vault) }));
  }

  settings(target: unknown): PipelineSettings {
    if (typeof target !== 'string' || !this.targets().has(target)) throw new Error('Schema unavailable');
    return this.workspaces.settings(target);
  }

  configure(target: unknown, stage: unknown, value: unknown, aliases: readonly string[]) {
    const settings = this.settings(target);
    const { schema } = this.targets().get(String(target))!;
    const next = { ...settings, ...stageSettings(stage, value, schema.document.fields as string[], aliases) };
    this.workspaces.configure(String(target), next, stage === 'testing');
    return next;
  }

  questionSets(target: string, name?: string) {
    const current = this.settings(target);
    const settings = name === undefined ? current : { ...current, testing: this.workspaces.testing(target, name) };
    if (name !== undefined) this.workspaces.configure(target, settings);
    return { settings, names: this.workspaces.questionSets(target) };
  }

  createWorkspace(title: string, target: unknown, allowModel: boolean) {
    const schema = typeof target === 'string' && this.targets().get(target)?.schema;
    if (!schema) throw new Error('Schema unavailable');
    const item = this.workspaces.create(string(title, 'title', 100).trim(), schema, allowModel);
    this.workspaces.configure(choiceId({ vault: item.id, title: item.title, schema, install: true }), this.settings(target));
    return this.workspace(item.id);
  }

  async importWorkspace(folder: string, title: string | undefined, target: unknown, allowModel: boolean,
    signal: AbortSignal, worker: typeof documentWorker) {
    if (!isLocalAbsoluteFolder(folder)) throw new Error('Choose a local BI repository folder');
    const schema = typeof target === 'string' && this.targets().get(target)?.schema;
    if (!schema) throw new Error('Schema unavailable');
    const { snapshot, conflicts } = await readWorkingRepository(folder, this.workspaces.root, worker, signal);
    signal.throwIfAborted();
    const item = this.workspaces.create(title?.trim() || snapshot.vault.title, schema, allowModel, snapshot, conflicts);
    this.workspaces.configure(choiceId({ vault: item.id, title: item.title, schema, install: true }), this.settings(target));
    return this.workspace(item.id);
  }

  workspace(id: string, offset = 0, cardId?: string) {
    const item = this.workspaces.get(id);
    if (!item) throw new Error('Unknown BI working draft');
    const { snapshot, schema, ...data } = item;
    const cards = snapshot?.cards.slice(offset, offset + 100).map(({ id, title, type }) => ({ id, title, type })) ?? [];
    return { ...data, choice: choiceId({ vault: id, title: item.title, schema, install: true }), cards, offset,
      ...(snapshot && { summary: counts(snapshot), withoutEvidence: withoutEvidence(snapshot) }),
      ...(cardId && { card: snapshot?.cards.find(({ id }) => id === cardId) }) };
  }

  editWorkspace(id: string, version: unknown, card: unknown, title: unknown, fields: unknown) {
    this.workspaces.edit(id, version, card, title, fields);
    return this.workspace(id);
  }

  prepareWorkspace(id: string, version: unknown) {
    const item = this.workspaces.get(id);
    if (!item?.snapshot?.cards.length || item.version !== version) throw new Error('BI working draft is empty or changed');
    const parent = this.knowledge.reviewStore.snapshot(id)?.publication.revision ?? null;
    const receipt = sha256(canonical([id, version, parent]));
    const repository = { ...counts(item.snapshot), tag: item.snapshot.repository!.tag, digestVerified: false, sizeVerified: false,
      withoutEvidence: withoutEvidence(item.snapshot) };
    const status: StoredStatus = { id: randomUUID(), source: { ref: item.title }, schema: item.schema.id, vault: id, title: item.title,
      state: 'validated', completedChunks: 0, totalChunks: 0, candidates: [], repository, baseRevision: parent,
      pending: { id: 'working-' + receipt, receipt, workspaceVersion: item.version, draft: { vault: item.snapshot.vault, repositorySnapshot: item.snapshot,
        allowModel: item.allowModel, parent } } };
    this.save(status, receipt);
    return this.status(status.id)!;
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
    return { count: schemas.size, choices: this.choices(worker !== documentWorker) };
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
    const { pending: _pending, checkpoint: _checkpoint, ...status } = JSON.parse(body) as StoredStatus;
    const review = status.reviewId && this.knowledge.reviewStore.reviewReceipt(status.reviewId);
    if (review) status.reviewState = review.publication ? 'published' : review.status;
    if (review && review.publication) status.publication = review.publication;
    return status;
  }

  private save(status: StoredStatus, receipt?: string) {
    if (status.mode) {
      const events = status.events ??= [];
      if (events.at(-1)?.state !== status.state) events.push({ state: status.state, at: new Date().toISOString() });
    }
    this.database().prepare(`INSERT INTO runs VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state,receipt=coalesce(excluded.receipt,runs.receipt)`)
      .run(status.id, JSON.stringify(status), status.state, receipt ?? null);
  }

  private load(id: string): StoredStatus {
    const row = this.database().prepare('SELECT status FROM runs WHERE id=?').get(id);
    if (!row) throw new Error('Unknown BI build');
    return JSON.parse(String(row.status));
  }

  submit(id: string, scheduled?: ScheduledReview) {
    const { pending, checkpoint, ...status } = this.load(id);
    if (status.reviewId) return this.status(id)!;
    if (status.state !== 'validated' || !pending) throw new Error('Validate the BI build first');
    if (Boolean(status.scheduled) !== Boolean(scheduled)) throw new Error('Scheduled run authorization required');
    const store = this.knowledge.reviewStore;
    const version = checkpoint?.workingVersion ?? pending.workspaceVersion;
    const working = version === undefined ? undefined : this.workspaces.get(pending.draft.vault.id);
    const provenance = scheduled?.provenance ?? { origin: 'owner', sourceKey: pending.receipt } as const;
    if (!store.hasReview(pending.id, pending.draft.vault.id, provenance)) {
      if (version !== undefined && working?.version !== version) throw new Error('BI working draft changed');
      if ('repositorySnapshot' in pending.draft) store.stageRepository(pending.id, pending.draft, provenance);
      else stageReviewProposal(store, pending.id, pending.draft, provenance);
    }
    if (status.mode && working && working.version === version && 'repositorySnapshot' in pending.draft) {
      this.workspaces.save({ ...working, snapshot: pending.draft.repositorySnapshot }, working.version);
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
    const repository = { ...counts(snapshot), tag: snapshot.repository!.tag, digestVerified, sizeVerified,
      withoutEvidence: withoutEvidence(snapshot) };
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

  start(input: DocumentInput, schema: unknown, consent: boolean, options?: BuildOptions) {
    this.stop.signal.throwIfAborted();
    options?.signal.throwIfAborted();
    if (this.running) throw new Error('Extraction already active');
    let target = typeof schema === 'string' ? this.targets(Boolean(options)).get(schema) : undefined;
    if (!target || !(target.schema.document.fields as string[]).length) throw new Error('Schema unavailable');
    const working = options && this.workspaces.get(target.vault);
    if (options?.title !== undefined && !working) {
      const title = string(options.title, 'title', 100).trim();
      target = { ...target, title, vault: 'bi-build-' + sha256(canonical([title, target.schema.sha256])), install: true };
    }
    const ref = 'url' in input ? this.publicUrl(input.url) : input.ref;
    string(ref, 'source', 2048);
    if ('bytes' in input && (!biDocumentFile(ref) || !input.bytes.length || input.bytes.length > documentFileLimit)) {
      throw new Error('Unsupported input');
    }
    const saved = options ? this.settings(schema) : defaults;
    const ocr = options ? options.ocr ?? saved.convert.ocr : { ...defaultOcr, mode: 'local' as const };
    const settings = { ...saved, convert: { ...saved.convert, ocr } };
    const checkpoint = { target, consent: working?.allowModel ?? consent, settings,
      workingVersion: working?.version, scheduled: options?.scheduled };
    const status: StoredStatus = { id: randomUUID(), source: { ref }, schema: target.schema.id, state: 'converting',
      completedChunks: 0, totalChunks: 0, candidates: [], checkpoint,
      ...(options && { vault: target.vault, title: target.title, mode: options.mode ?? 'automatic', stage: 'convert' as const }),
      ...(options?.scheduled && { scheduled: true }) };
    this.save(status);
    this.run(status, options, async (signal, worker) => {
      const segments = await this.convert(input, status, signal, worker, Boolean(options && !options.scheduled), checkpoint.settings.convert);
      signal.throwIfAborted();
      status.conversion = { segments: segments.length, preview: segments.slice(0, 5).map(({ locator, text, ocr }) =>
        ({ locator, text: text.slice(0, 1500).toWellFormed(), ocr })) };
      if (status.mode === 'step') {
        status.state = 'converted';
        this.save(status);
      } else await this.ingest(segments, checkpoint, status, signal, worker);
    });
    return this.status(status.id)!;
  }

  resume(id: string, options: BuildOptions) {
    const status = this.load(id);
    const checkpoint = status.checkpoint;
    if (this.running || !checkpoint || status.mode !== 'step' || !['converted', 'ingested'].includes(status.state)) {
      throw new Error('BI run cannot resume');
    }
    if (status.state === 'converted') {
      const record = this.database().prepare('SELECT projection FROM documents WHERE id=?').get(status.source.documentId!);
      if (!record) throw new Error('Converted source unavailable');
      const { segments } = JSON.parse(String(record.projection)) as Projection;
      this.run(status, options, (signal, worker) => this.ingest(segments, checkpoint, status, signal, worker));
    } else this.run(status, options, signal => this.test(status, checkpoint, signal));
    return this.status(id)!;
  }

  private run(status: StoredStatus, options: BuildOptions | undefined,
    work: (signal: AbortSignal, worker: typeof documentWorker) => Promise<void>) {
    const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(12 * 60_000), ...(options ? [options.signal] : [])]);
    signal.throwIfAborted();
    this.running = work(signal, options?.worker ?? documentWorker).catch((error: unknown) => {
      status.state = 'failed';
      status.issue = this.stop.signal.aborted || options?.signal.aborted ? 'interrupted' :
        error instanceof DocumentWorkerError || error instanceof ExtractionError ? error.issue :
          error instanceof Error && error.message === 'isolation-unavailable' ? 'isolation-unavailable' : 'invalid';
      this.save(status);
    }).finally(() => { this.running = undefined; });
  }

  private publicUrl(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Expected a public HTTPS URL');
    url.hash = '';
    return url.href;
  }

  private async convert(input: DocumentInput, status: StoredStatus, signal: AbortSignal, worker: typeof documentWorker, explicitUrl: boolean,
    settings: PipelineSettings['convert']) {
    const { source } = status;
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
    if (settings.reader !== 'auto' && settings.reader !== kind) throw new ExtractionError('invalid');
    source.sha256 = sha256(bytes);
    const id = sha256(canonical(['v1', kind, charset, source.sha256]));
    const db = this.database();
    const existing = db.prepare('SELECT projection FROM documents WHERE id=?').get(id);
    const cached = existing && JSON.parse(String(existing.projection)) as Projection;
    const rasterCapable = kind === 'pdf' || kind === 'image';
    const recognize = rasterCapable ? documentOcr(settings.ocr, this.knowledge.ocrVision, this.model?.()) : undefined;
    const reuse = cached && (!rasterCapable || (cached.pages?.length && cached.pages.every(({ status }) => status === 'text-layer')));
    const projection = reuse ? cached : await worker<Projection>(['convert', kind, charset], bytes, signal, recognize &&
      (async (params, workerSignal) => {
        const { status: pageStatus, warning, ocr, ...result } = await recognize(params, workerSignal);
        const page = { locator: `page:${params.page}`, status: pageStatus, warning, ocr };
        (status.pages ??= []).push(page);
        this.save(status);
        return { status: pageStatus, warning, ocr, ...result };
      }));
    if (projection.sha256 !== source.sha256) throw new ExtractionError('invalid');
    status.pages = projection.pages?.length ? projection.pages : undefined;
    source.title = projection.title || source.ref;
    if (!projection.segments.length) throw new ExtractionError('ocr');
    const recognized = projection.pages?.some(({ status }) => status !== 'text-layer');
    // Keep existing text receipts stable. A new recognition can change both the text and its evidence provenance.
    source.documentId = recognized ? sha256(canonical(['ocr-v1', id,
      projection.segments.map(({ locator, text, ocr }) => [locator, text, ocr ?? null])])) : id;
    if (!reuse) db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?)').run(source.documentId, JSON.stringify(projection));
    return projection.segments;
  }

  private async extractChunk(prompt: string, fields: string[], segments: Chunk, signal: AbortSignal, settings: PipelineSettings['ingest']) {
    const alias = settings.model || this.model?.();
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      if (attempt) await delay(250 * attempt, undefined, { signal });
      const response = await this.knowledge.propose(prompt, { fields, segments, ...(Object.keys(settings.labels).length &&
        { fieldLabels: settings.labels }) }, signal, alias, undefined, 4096);
      signal.throwIfAborted();
      if ('content' in response) {
        try { return modelCandidates(response.content); }
        catch { /* Retry malformed or truncated JSON with the same request. */ }
      } else if (!response.retryable) break;
    }
    throw new ExtractionError('model');
  }

  private async ingest(segments: Projection['segments'], checkpoint: Checkpoint, status: StoredStatus, signal: AbortSignal,
    worker: typeof documentWorker) {
    signal.throwIfAborted();
    const { target, consent, settings } = checkpoint;
    const config = settings.ingest;
    const pluginBuild = Boolean(status.mode);
    status.stage = pluginBuild ? 'ingest' : undefined;
    status.state = 'extracting';
    this.save(status);
    const store = this.knowledge.reviewStore;
    const { vault, schema } = target;
    if (target.install) store.installReviewSchema(vault, schema.id, schema.version, schema.document.fields);
    const base = store.reviewBase(vault);
    if (base.schema.sha256 !== schema.sha256 || base.vault && base.vault.kind !== 'bi') throw new ExtractionError('base-changed');
    const working = checkpoint.workingVersion === undefined ? undefined : this.workspaces.get(vault);
    if (checkpoint.workingVersion !== undefined && working?.version !== checkpoint.workingVersion) throw new ExtractionError('base-changed');
    const snapshotBase = working?.snapshot ?? (base.parent ? store.snapshot(vault, base.parent) : undefined);
    const baseCards = snapshotBase?.cards ?? [];
    status.baseRevision = base.parent;
    const changedRules = canonical(settings.ingest) !== canonical(defaults.ingest);
    const receipt = sha256(canonical([vault, schema.sha256, status.source.documentId, status.source.ref,
      ...(changedRules ? [settings.ingest] : []), ...(checkpoint.workingVersion === undefined ? [] : [checkpoint.workingVersion]),
      ...(checkpoint.scheduled ? [checkpoint.scheduled.id] : [])]));
    const reviewId = checkpoint.scheduled?.id ?? 'extract-' + sha256(canonical([receipt, base.parent]));
    const previous = this.database().prepare(`SELECT status FROM runs WHERE receipt=? AND id<>?
      ORDER BY rowid DESC LIMIT 1`).get(receipt, status.id);
    const prior = previous && JSON.parse(String(previous.status)) as ExtractionStatus;
    const provenance = checkpoint.scheduled?.provenance ?? { origin: 'owner', sourceKey: receipt } as const;
    const priorId = prior?.reviewId;
    const earlier = priorId && store.reviewReceipt(priorId);
    let reusableReview;
    if (priorId && earlier && (earlier.publication || earlier.parent === base.parent) && store.hasReview(priorId, vault, provenance)) {
      reusableReview = priorId;
    } else if (store.hasReview(reviewId, vault, provenance)) reusableReview = reviewId;
    if (reusableReview || (!pluginBuild && prior?.state === 'needs-attention' && prior.baseRevision === base.parent)) {
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
    status.totalChunks = plan.chunks.length;
    this.save(status);
    const fields = schema.document.fields as string[];
    const partials: ReturnType<typeof verifyCandidate>[] = [];
    for (const chunk of plan.chunks) {
      const extracted = config.method === 'rules' ? await worker<ReturnType<typeof modelCandidates>>(['rules'],
        json({ chunk, fields, labels: config.labels }), signal) : await this.extractChunk(plan.prompt, fields, chunk, signal, config);
      partials.push(...extracted.map(candidate => verifyCandidate(candidate, chunk, segments, fields, status.source.ref, reviewId)));
      status.completedChunks++;
      this.save(status);
    }
    status.state = 'validating';
    this.save(status);
    const identities = await worker<string[]>(['identities'], json(partials.map(({ name }) => ['record', name])), signal);
    status.candidates = consolidate(partials, identities, fields);
    const publishedFields = new Set(baseCards.map(card => canonical(card.fields)));
    const publishedKeys = new Set(baseCards.filter(({ type }) => type === 'record').map(({ key }) => key));
    for (const candidate of status.candidates) {
      if (candidate.state === 'pass' && new Set(Object.values(candidate.evidence).map(({ segment, quote }) =>
        canonical([segment, quote]))).size < config.minEvidence) {
        candidate.state = 'needs-attention';
        candidate.issues.push({ code: 'missing-evidence' });
      }
      if (candidate.state === 'pass' && (publishedKeys.has(candidate.id) || publishedFields.has(canonical(candidate.fields))) &&
          !(config.duplicates === 'update' && publishedKeys.has(candidate.id) && !publishedFields.has(canonical(candidate.fields)))) {
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
      parent: snapshotBase?.publication.revision ?? null, schema: schema.sha256,
      allowModel: working?.allowModel ?? (base.vault ? base.allowModel : consent),
      addCards: [], updateCards: [], removeCards: [], sources: [], evidence: [], relationships: [],
    };
    const uploads = new Map<number, string>();
    for (const candidate of accepted) {
      const previousCard = baseCards.find(({ type, key }) => type === 'record' && key === candidate.id);
      const cardId = previousCard?.id ?? 'card-' + candidate.id;
      const destination = previousCard ? draft.updateCards : draft.addCards;
      destination.push({ id: cardId, key: candidate.id, type: 'record', title: candidate.name,
        version: previousCard ? String(Number(previousCard.version) + 1) : '1', fields: candidate.fields });
      for (const [field, { segment, locator, start, quote, ocr }] of Object.entries(candidate.evidence)) {
        let sourceId = uploads.get(segment);
        if (!sourceId) {
          sourceId = 'source-' + reviewId + '-' + (segment + 1);
          const bytes = Buffer.from(segments[segment].text);
          const hash = sha256(bytes);
          store.uploadReviewSource(hash, bytes);
          draft.sources.push({ id: sourceId, ref: status.source.ref, sha256: hash, locator: ocrLocator(locator, ocr) });
          uploads.set(segment, sourceId);
        }
        draft.evidence.push({ sourceId, cardId, field, start, end: start + quote.length });
      }
    }
    signal.throwIfAborted();
    // The same materializer runs again inside the review transaction and on publish.
    const preview = materializeChange(draft, snapshotBase, schema,
      'verify-' + status.id, hash => store.reviewSource(hash));
    if (pluginBuild) {
      const repository = working?.snapshot?.repository;
      status.pending = { id: reviewId, receipt, draft: repository ? { vault: draft.vault,
        repositorySnapshot: { ...preview, repository, schema: working.snapshot!.schema }, allowModel: consent, parent: base.parent } : draft };
      if (checkpoint.scheduled) {
        status.state = 'validated';
        this.save(status, receipt);
      } else if (status.mode === 'step') {
        status.state = 'ingested';
        this.save(status, receipt);
      } else await this.test(status, checkpoint, signal, preview);
    } else {
      stageReviewProposal(store, reviewId, draft, provenance);
      this.recordReview(status, reviewId, receipt);
    }
  }

  private async test(status: StoredStatus, { settings, consent, target }: Checkpoint, signal: AbortSignal, preview?: Snapshot) {
    const pending = status.pending;
    if (!pending) throw new ExtractionError('invalid');
    const store = this.knowledge.reviewStore;
    const base = store.reviewBase(target.vault);
    if (base.parent !== pending.draft.parent || base.schema.sha256 !== target.schema.sha256) throw new ExtractionError('base-changed');
    status.state = 'testing';
    status.stage = 'testing';
    this.save(status, pending.receipt);
    const snapshot = preview ?? ('repositorySnapshot' in pending.draft ? pending.draft.repositorySnapshot :
      materializeChange(pending.draft, base.parent ? store.snapshot(target.vault, base.parent) : undefined,
        target.schema, 'verify-' + status.id, hash => store.reviewSource(hash)));
    status.benchmark = await runBenchmark(snapshot, settings.testing, consent ? this.knowledge.propose : undefined, signal);
    signal.throwIfAborted();
    status.state = status.benchmark.state === 'failed' ? 'needs-attention' : 'validated';
    this.save(status, pending.receipt);
  }
}
