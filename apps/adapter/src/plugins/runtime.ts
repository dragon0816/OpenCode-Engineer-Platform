import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { readApprovedLink } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import { sourceUploadLimit } from '../../../../packages/knowledge/src/ingest.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import type { DocumentExtraction } from '../bi/document-extraction.ts';
import { documentResult } from '../bi/document-worker.ts';
import { proposeReview } from '../http/review.ts';
import type { ReferencePicker } from '../runs/reference-picker.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from '../runs/workspace.ts';
import { digestPattern, sha256, strictJSON, type VerifiedPlugin } from './package.ts';
import { runPython } from './python.ts';
import type { PluginRegistry } from './registry.ts';
import { PluginError, requirePlugin } from './zip.ts';

type Grant = { id: string; page: string; owner: string; generation: string; plugin: VerifiedPlugin; expires: number;
  sources: Map<string, Source>; stop: AbortController };
type BiBuilder = { extraction: DocumentExtraction; picker: ReferencePicker };
type Source = { id: string; name: string; sha256: string; confidential: boolean; bytes: Buffer };
type Proposal = { draft: string; source: string; proposal: string };
type State = 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
type Update = { id: string; state: State; percent: number; error?: string; result?: unknown; review?: string };
type Job = { plugin: string; owner: string; generation: string; sources: Map<string, Source>; controller: AbortController;
  update: Update; done: Promise<void>; streams: Set<ServerResponse>; proposal?: Proposal; models: number; writes: number; drafts: number };
type Draft = { id: string; title: string; reviewType: string };
export const sourceLimit = 8 * 1024 * 1024;
const dataLimit = 128 * 1024;
const idPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/;
const expiresAfter = 30 * 60_000;
const terminal = (state: State) => state !== 'starting' && state !== 'running';
const describeSource = ({ bytes, ...source }: Source) => ({ ...source, size: bytes.length });
const failure = (error: unknown) => error instanceof PluginError ? error.code : 'operation-failed';
const biPlugin = 'oep.bi-knowledge';
const biPage = biPlugin + '.build';
const biWorker = biPlugin + '.document';

function text(input: unknown, max: number) {
  requirePlugin(typeof input === 'string' && input.trim() && input.length <= max, 'runtime-input');
  return input;
}

function id(input: unknown) {
  const value = text(input, 36);
  requirePlugin(idPattern.test(value), 'runtime-input');
  return value;
}

function directory(path: string) {
  checkDirectory(dirname(path));
  if (!existsSync(path)) mkdirSync(path);
  checkDirectory(path);
  return path;
}

function safeWrite(root: string, name: string, bytes: Uint8Array) {
  const target = scopedPath(root, name);
  let folder = root;
  for (const part of name.split('/').slice(0, -1)) folder = directory(join(folder, part));
  if (existsSync(target)) openWorkspaceFile(root, name, dataLimit);
  const temporary = join(folder, randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class PluginRuntime {
  private readonly grants = new Map<string, Grant>();
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private readonly registry: PluginRegistry;
  private readonly root: string;
  private readonly knowledge: Runtime['knowledge'];
  private readonly bi?: BiBuilder;
  private readonly reference: (session: string, source: string, sha256: string) =>
    { name: string; bytes: Buffer; confidential: boolean };

  constructor(registry: PluginRegistry, root: string, knowledge: Runtime['knowledge'], reference: PluginRuntime['reference'],
    bi?: BiBuilder) {
    this.registry = registry;
    this.root = root;
    this.knowledge = knowledge;
    this.reference = reference;
    this.bi = bi;
    registry.onDeactivate = (plugin) => this.deactivate(plugin);
  }

  private deactivate(plugin: string) {
    for (const [token, grant] of this.grants) if (grant.id === plugin) this.retire(token);
    for (const [key, job] of this.jobs) {
      if (job.plugin !== plugin) continue;
      job.controller.abort('cancelled');
      for (const stream of job.streams) stream.end();
      if (terminal(job.update.state)) this.jobs.delete(key);
    }
  }

  async close() {
    this.closed = true;
    for (const token of this.grants.keys()) this.retire(token);
    for (const job of this.jobs.values()) {
      job.controller.abort('cancelled');
      for (const stream of job.streams) stream.end();
    }
    await Promise.all([...this.jobs.values()].map(({ done }) => done));
    this.jobs.clear();
  }

  private retire(token: string) {
    this.grants.get(token)?.stop.abort('cancelled');
    this.grants.delete(token);
  }

  page(pluginId: string, component: string, digest: string, owner: string) {
    const { plugin, generation } = this.registry.active(pluginId, digest);
    requirePlugin(plugin.manifest.components.pages.some(({ id }) => id === component), 'page-not-found');
    const view = plugin.views.find(({ id }) => id === component)!;
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.retire(token);
    const verified = [...this.grants.values()].find((grant) => grant.id === pluginId && grant.generation === generation)?.plugin ?? plugin;
    if (this.grants.size >= 16) this.retire(this.grants.keys().next().value!);
    const token = randomUUID();
    this.grants.set(token, { id: pluginId, page: component, owner, generation, plugin: verified, expires: now + expiresAfter,
      sources: new Map(), stop: new AbortController() });
    return { ...view, token, approvedSources: plugin.manifest.permissions.sourceBroker === 'approved-sources',
      ...(this.bi && pluginId === biPlugin && component === biPage && { biBuilder: true }) };
  }

  authorize(plugin: string, owner: string, token: string) {
    const grant = this.grants.get(token);
    requirePlugin(grant && grant.id === plugin && grant.owner === owner && grant.expires > Date.now(), 'runtime-forbidden');
    this.active(grant);
    return grant;
  }

  private active(grant: Grant) {
    requirePlugin(!this.closed && this.registry.current(grant.id, grant.generation), 'runtime-forbidden');
  }

  addSource(grant: Grant, name: string, bytes: Buffer, confidential = false) {
    this.active(grant);
    requirePlugin(grant.plugin.manifest.permissions.sourceBroker === 'approved-sources', 'runtime-forbidden');
    requirePlugin(bytes.length > 0 && bytes.length <= sourceLimit && grant.sources.size < 16 &&
      [...grant.sources.values()].reduce((total, source) => total + source.bytes.length, bytes.length) <= 16 * 1024 * 1024 &&
      typeof name === 'string' && name.trim() && name.length <= 200 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name), 'runtime-input');
    const entry = { id: randomUUID(), name, sha256: sha256(bytes), bytes, confidential };
    grant.sources.set(entry.id, entry);
    return describeSource(entry);
  }

  private job(grant: Grant, key: unknown) {
    const job = this.jobs.get(id(key));
    requirePlugin(job && job.plugin === grant.id && job.owner === grant.owner &&
      job.generation === grant.generation, 'runtime-forbidden');
    return job;
  }

  private emit(job: Job, update: Partial<Update>) {
    job.update = { ...job.update, ...update };
    for (const response of job.streams) this.frame(job, response);
  }

  private frame(job: Job, response: ServerResponse) {
    if (response.destroyed || response.writableEnded) return;
    const frame = 'data: ' + JSON.stringify(job.update) + '\n\n';
    if (terminal(job.update.state)) response.end(frame);
    else if (!response.write(frame)) response.destroy();
  }

  stream(grant: Grant, key: string, response: ServerResponse) {
    const job = this.job(grant, key);
    requirePlugin(job.streams.size < 4, 'runtime-busy');
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
    job.streams.add(response);
    response.once('close', () => job.streams.delete(response));
    this.frame(job, response);
  }

  private start(grant: Grant, params: Record<string, unknown>) {
    const worker = grant.plugin.manifest.components.pythonWorkers.find(({ id }) => id === params.worker);
    requirePlugin(worker, 'runtime-forbidden');
    const selected = params.sources ?? [];
    requirePlugin(Array.isArray(selected) && selected.length <= 16 && new Set(selected).size === selected.length, 'runtime-input');
    const sources = new Map(selected.map((key) => {
      const source = grant.sources.get(id(key));
      requirePlugin(source, 'runtime-forbidden');
      return [source.id, source];
    }));
    const input = params.input ?? {};
    requirePlugin(Buffer.byteLength(JSON.stringify(input)) <= 32_000, 'runtime-input');
    return this.launch(grant, worker, input, sources).update;
  }

  private launch(grant: Grant, worker: VerifiedPlugin['manifest']['components']['pythonWorkers'][number], input: unknown,
    sources: Map<string, Source>, documentSignal?: AbortSignal) {
    const active = [...this.jobs.values()].filter(({ update }) => !terminal(update.state));
    requirePlugin(active.length < 3 && !active.some((job) => job.plugin === grant.id), 'runtime-busy');
    if (this.jobs.size >= 32) {
      const oldest = [...this.jobs].find(([, job]) => terminal(job.update.state));
      if (oldest) this.jobs.delete(oldest[0]);
    }
    const controller = new AbortController();
    const update: Update = { id: randomUUID(), state: 'starting', percent: 0 };
    const job: Job = { plugin: grant.id, owner: grant.owner, generation: grant.generation, sources, controller, update,
      done: Promise.resolve(), streams: new Set(), models: 0, writes: 0, drafts: 0 };
    this.jobs.set(update.id, job);
    let timer = setTimeout(() => controller.abort('timed-out'), 30_000);
    const signal = documentSignal ? AbortSignal.any([controller.signal, documentSignal]) : controller.signal;
    job.done = runPython(this.root, grant.plugin, worker, input, signal, () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort('timed-out'), worker.timeoutMs);
      this.emit(job, { state: 'running' });
    }, (method, params) => {
      requirePlugin(!documentSignal || method === 'sources.read', 'runtime-forbidden');
      return this.call(grant, method, params, job);
    }, documentSignal ? 2 * 1024 * 1024 : undefined).then(async (result) => {
      this.active(grant);
      signal.throwIfAborted();
      const review = job.proposal && await this.propose(grant, job, job.proposal);
      this.emit(job, { state: 'succeeded', percent: 100, result, review });
    }).catch((error: unknown) => {
      const reason = signal.reason;
      this.emit(job, reason === 'cancelled' || reason === 'timed-out' ? { state: reason } :
        { state: 'failed', error: failure(error) });
    }).finally(() => {
      clearTimeout(timer);
      job.sources.clear();
      job.proposal = undefined;
      if (!this.registry.current(grant.id, grant.generation)) this.jobs.delete(update.id);
    });
    return job;
  }

  private async build(grant: Grant, method: string, params: Record<string, unknown>) {
    const permissions = grant.plugin.manifest.permissions;
    const worker = grant.plugin.manifest.components.pythonWorkers.find(({ id }) => id === biWorker);
    requirePlugin(this.bi && grant.id === biPlugin && grant.page === biPage && worker &&
      permissions.operations.includes('review.submit') && permissions.operations.includes('publish.request') &&
      permissions.modelBroker === 'approved-gateway' && permissions.sourceBroker === 'approved-sources', 'runtime-forbidden');
    const { extraction, picker } = this.bi;
    const { signal } = grant.stop;
    signal.throwIfAborted();
    const run = async <T>([operation, ...args]: string[], bytes: Buffer, parent: AbortSignal) => {
      this.active(grant);
      parent.throwIfAborted();
      const source = { id: randomUUID(), sha256: sha256(bytes), bytes, name: operation, confidential: false };
      const job = this.launch(grant, worker, { operation, args, source: source.id }, new Map([[source.id, source]]), parent);
      await job.done;
      parent.throwIfAborted();
      requirePlugin(job.update.state === 'succeeded', job.update.error ?? 'worker-failed');
      return documentResult<T>(job.update.result);
    };
    switch (method) {
      case 'bi.catalog': return { choices: extraction.choices(), runs: extraction.recent(true) };
      case 'bi.pick': {
        requirePlugin(params.locale === 'en' || params.locale === 'zh-TW', 'runtime-input');
        return { folder: (await picker('folder', params.locale, signal))[0] };
      }
      case 'bi.schemas': return extraction.importSchemas(params.folder, signal, run);
      case 'bi.repository': {
        requirePlugin(!extraction.busy(), 'runtime-busy');
        requirePlugin(typeof params.allowModel === 'boolean', 'runtime-input');
        return extraction.importRepository(text(params.folder, 2048), params.allowModel,
          params.title === undefined ? undefined : text(params.title, 100));
      }
      case 'bi.start': {
        requirePlugin(!extraction.busy(), 'runtime-busy');
        requirePlugin(typeof params.allowModel === 'boolean', 'runtime-input');
        const title = params.title === undefined ? undefined : text(params.title, 100);
        const options = { worker: run, signal, title };
        if (params.url !== undefined) {
          requirePlugin(params.source === undefined, 'runtime-input');
          return extraction.start({ url: text(params.url, 2048) }, params.schema, params.allowModel, options);
        }
        const source = grant.sources.get(id(params.source));
        requirePlugin(source && !source.confidential, 'runtime-forbidden');
        const status = extraction.start({ ref: source.name, bytes: source.bytes }, params.schema, params.allowModel, options);
        grant.sources.delete(source.id);
        return status;
      }
      case 'bi.status':
      case 'bi.submit': {
        const key = id(params.id);
        const status = extraction.status(key);
        requirePlugin(status?.vault, 'runtime-forbidden');
        return method === 'bi.submit' ? extraction.submit(key) : status;
      }
      default: throw new PluginError('runtime-forbidden');
    }
  }

  private metadata(grant: Grant) {
    const registry = directory(join(this.root, 'plugins'));
    return directory(join(directory(join(registry, 'runtime')), grant.id));
  }

  private draft(grant: Grant, value: unknown) {
    return JSON.parse(openWorkspaceFile(this.metadata(grant), 'draft-' + id(value) + '.json', dataLimit).data.toString()) as Draft;
  }

  private createDraft(grant: Grant, params: Record<string, unknown>) {
    requirePlugin(this.knowledge, 'runtime-forbidden');
    const { plugin } = grant;
    const type = plugin.manifest.components.reviewTypes.find(({ id }) => id === params.reviewType);
    requirePlugin(type, 'runtime-forbidden');
    const schema = plugin.manifest.components.dataSchemas.find(({ id }) => id === type.schema)!;
    const doc = strictJSON(plugin.payload.get('payload/' + schema.entry)!) as Record<string, unknown>;
    const title = text(params.title, 100);
    requirePlugin(!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(title), 'runtime-input');
    const draft: Draft = { id: randomUUID(), title, reviewType: type.id };
    const file = join(this.metadata(grant), 'draft-' + draft.id + '.json');
    writeFileSync(file, JSON.stringify(draft), { flag: 'wx' });
    try { this.knowledge.reviewStore.installReviewSchema(draft.id, schema.id, schema.version, doc.fields); }
    catch (error) { unlinkSync(file); throw error; }
    return draft;
  }

  private async propose(grant: Grant, job: Job, proposal: Proposal) {
    const { controller: { signal } } = job;
    const draft = this.draft(grant, proposal.draft);
    const source = job.sources.get(proposal.source);
    requirePlugin(this.knowledge && source && source.bytes.length <= sourceUploadLimit, 'runtime-forbidden');
    const store = this.knowledge.reviewStore;
    const base = store.reviewBase(draft.id);
    const id = job.update.id;
    const vault = { id: draft.id, title: draft.title, kind: 'bi' } as const;
    // Write ownership before staging. A receipt without a review has no effect and cannot be published.
    const file = join(this.metadata(grant), 'review-' + id + '.json');
    writeFileSync(file, JSON.stringify({ draft: draft.id, type: draft.reviewType }), { flag: 'wx' });
    try {
      store.uploadReviewSource(source.sha256, source.bytes);
      const result = await proposeReview(store, { id, vault: draft.id, parent: base.parent, schema: base.schema.sha256,
        sha256: source.sha256, ref: 'plugin-source:' + source.id }, async () => {
        this.active(grant);
        signal.throwIfAborted();
        return { content: proposal.proposal };
      }, signal, undefined, vault);
      requirePlugin('id' in result && result.id, 'proposal-evidence');
      return result.id;
    } catch (error) {
      unlinkSync(file);
      throw error;
    }
  }

  panel(grant: Grant, component: string) {
    requirePlugin(grant.plugin.manifest.components.panels.some(({ id }) => id === component), 'page-not-found');
    return grant.plugin.views.find(({ id }) => id === component)!;
  }

  async call(grant: Grant, method: string, params: Record<string, unknown>, job?: Job): Promise<unknown> {
    this.active(grant);
    job?.controller.signal.throwIfAborted();
    const { permissions, components } = grant.plugin.manifest;
    const allow = (operation: typeof permissions.operations[number]) =>
      requirePlugin(permissions.operations.includes(operation), 'runtime-forbidden');
    const sources = job?.sources ?? grant.sources;
    const selected = () => {
      requirePlugin(permissions.sourceBroker === 'approved-sources', 'runtime-forbidden');
      const source = sources.get(id(params.id));
      requirePlugin(source, 'runtime-forbidden');
      return source;
    };
    switch (method) {
      case 'sources.list':
        requirePlugin(permissions.sourceBroker === 'approved-sources', 'runtime-forbidden');
        return [...sources.values()].map(describeSource);
      case 'sources.read': {
        const source = selected();
        return { ...describeSource(source), base64: source.bytes.toString('base64') };
      }
      case 'data.read': {
        allow('data.read');
        const root = directory(join(directory(join(this.root, 'plugin-data')), grant.id));
        return { base64: openWorkspaceFile(root, text(params.path, 200), dataLimit).data.toString('base64') };
      }
      case 'data.write': {
        allow('data.write');
        requirePlugin(!job || ++job.writes <= 32, 'runtime-busy');
        const encoded = params.base64;
        requirePlugin(typeof encoded === 'string' && encoded.length <= Math.ceil(dataLimit / 3) * 4, 'runtime-input');
        const bytes = Buffer.from(encoded, 'base64');
        requirePlugin(bytes.length <= dataLimit && bytes.toString('base64') === encoded, 'runtime-input');
        const root = directory(join(directory(join(this.root, 'plugin-data')), grant.id));
        safeWrite(root, text(params.path, 200), bytes);
        return { bytes: bytes.length, sha256: sha256(bytes) };
      }
      case 'reviews.status': {
        allow('review.submit');
        const key = id(params.id);
        const root = this.metadata(grant);
        const name = 'review-' + key + '.json';
        requirePlugin(existsSync(join(root, name)), 'runtime-forbidden');
        const meta = JSON.parse(openWorkspaceFile(root, name, dataLimit).data.toString());
        const status = this.knowledge?.reviewStore.reviewStatus(key);
        requirePlugin(status?.vault === meta.draft, 'runtime-forbidden');
        return { ...status, reviewType: meta.type };
      }
      case 'drafts.create':
        allow('review.submit');
        requirePlugin(!job || ++job.drafts <= 2, 'runtime-busy');
        return this.createDraft(grant, params);
    }
    if (job) {
      switch (method) {
        case 'progress.emit':
          allow('progress.emit');
          requirePlugin(typeof params.percent === 'number' && Number.isInteger(params.percent) &&
            params.percent >= job.update.percent && params.percent <= 99, 'runtime-input');
          this.emit(job, { percent: params.percent });
          return null;
        case 'models.complete': {
          requirePlugin(permissions.modelBroker === 'approved-gateway' && this.knowledge &&
            ![...sources.values()].some((source) => source.confidential) && ++job.models <= 8, 'runtime-forbidden');
          const prompt = text(params.prompt, 4_000);
          const input = params.input ?? null;
          requirePlugin(Buffer.byteLength(JSON.stringify(input)) <= 24_000, 'runtime-input');
          const response = await this.knowledge.propose(prompt, input, job.controller.signal);
          requirePlugin('content' in response && Buffer.byteLength(response.content) <= 24_000, 'model-unavailable');
          return { content: response.content };
        }
        case 'reviews.propose':
          allow('review.submit');
          requirePlugin(!job.proposal && sources.has(id(params.source)), 'runtime-forbidden');
          const proposal = JSON.stringify(params.proposal ?? null);
          requirePlugin(Buffer.byteLength(proposal) <= 24_000, 'runtime-input');
          job.proposal = { draft: this.draft(grant, params.draft).id, source: id(params.source), proposal };
          return { queued: true };
        default: throw new PluginError('runtime-forbidden');
      }
    }
    switch (method) {
      case 'components.list':
        return { panels: components.panels.map(({ id }) => id), reviewTypes: components.reviewTypes,
          collections: components.collections, workers: components.pythonWorkers.map(({ id }) => id) };
      case 'jobs.start': return this.start(grant, params);
      case 'jobs.status': return this.job(grant, params.id).update;
      case 'jobs.cancel': {
        const job = this.job(grant, params.id);
        if (!terminal(job.update.state)) job.controller.abort('cancelled');
        return job.update;
      }
      case 'sources.reference': {
        requirePlugin(permissions.sourceBroker === 'approved-sources' && typeof params.sha256 === 'string' &&
          digestPattern.test(params.sha256), 'runtime-forbidden');
        const { name, bytes, confidential } = this.reference(id(params.session), id(params.source), params.sha256);
        return this.addSource(grant, name, bytes, confidential);
      }
      case 'sources.url': {
        requirePlugin(permissions.sourceBroker === 'approved-sources', 'runtime-forbidden');
        const url = new URL(text(params.url, 2_048));
        const bytes = await readApprovedLink(url.href, new Set([url.origin]), AbortSignal.timeout(8_000));
        return this.addSource(grant, url.hostname, bytes);
      }
      case 'publish.request': {
        allow('publish.request');
        const status = await this.call(grant, 'reviews.status', params);
        return { status, route: '#review' };
      }
      default:
        if (method.startsWith('bi.')) return this.build(grant, method, params);
        throw new PluginError('runtime-forbidden');
    }
  }
}
