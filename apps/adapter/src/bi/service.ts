import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readApprovedLink } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import { key } from '../../../../packages/knowledge/src/ingest.ts';
import type { KnowledgeStore } from '../../../../packages/knowledge/src/store.ts';
import type { BiProvenance } from '../../../../packages/knowledge/src/bi/ownership.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import type { Destination } from '../channels/transport.ts';
import { proposeReview } from '../http/review.ts';
import { maxUpload } from '../runs/attachments.ts';
import { legacyBiReviewKey } from './source-ownership.ts';

const extensions = new Set(['.txt', '.md', '.csv', '.png', '.jpg', '.jpeg', '.pdf', '.xlsx']);
const textExtensions = new Set(['.txt', '.md', '.csv']);

type Storage = { db: DatabaseSync; transaction<T>(work: () => T): T };
type IntakeFile = { name: string; size?: number; read(limit: number, signal: AbortSignal): Promise<Uint8Array> };
type ProposalStore = Pick<KnowledgeStore, 'reviewBase' | 'hasReview' | 'uploadReviewSource' | 'reviewSource' | 'stage' |
  'installReviewSchema' | 'enqueueBi' | 'runBi' | 'biCompleted'>;
type ProposalServices = { store: ProposalStore; complete: NonNullable<Runtime['knowledge']>['propose'] };
type DelegatedSource = { id: string; runId: string; workId: string; model: string; task: string;
  files: { name: string; data: Buffer }[] };

export function biProposalServices(knowledge: Runtime['knowledge'], model: () => string | undefined): ProposalServices | undefined {
  if (!knowledge) return;
  const store = knowledge.reviewStore;
  return { complete: (prompt, input, signal, selected = model(), beforeRequest) =>
    knowledge.propose(prompt, input, signal, selected, beforeRequest), store: {
    reviewBase: store.reviewBase.bind(store), hasReview: store.hasReview.bind(store),
    uploadReviewSource: store.uploadReviewSource.bind(store), reviewSource: store.reviewSource.bind(store),
    stage: store.stage.bind(store), installReviewSchema: store.installReviewSchema.bind(store),
    enqueueBi: store.enqueueBi.bind(store), runBi: store.runBi.bind(store), biCompleted: store.biCompleted.bind(store),
  } };
}

export class BiService {
  private readonly storage: Storage;
  private readonly proposal?: ProposalServices;
  private readonly staging = new Map<number, Promise<void>>();

  constructor(storage: Storage, proposal?: ProposalServices) {
    this.storage = storage;
    this.proposal = proposal;
  }

  config(name: string) {
    return String(this.storage.db.prepare('SELECT value FROM bi_config WHERE name=?').get(name)?.value ?? '');
  }

  configure(domain: unknown, origins: unknown, target: unknown = '') {
    const name = key(domain);
    if (name.length > 60 || !Array.isArray(origins) || origins.length > 30) throw new Error('Invalid inbox settings');
    const approved = origins.map((origin) => {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid approved source');
      return url.origin;
    });
    const vault = target === '' ? '' : key(target);
    if (vault && this.proposal?.store.reviewBase(vault).vault?.kind !== 'bi') throw new Error('Expected an active BI vault');
    this.storage.transaction(() => {
      const save = this.storage.db.prepare('INSERT INTO bi_config VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
      save.run('domain', name);
      save.run('origins', JSON.stringify(approved));
      save.run('target', vault);
    });
  }

  private sourceState(id: number, origin?: Destination) {
    const db = this.storage.db;
    if (!origin) return db.prepare(`SELECT s.state FROM bi_sources s JOIN bi_source_ownership o ON o.source_id=s.id
      WHERE s.id=? AND o.agent_id='bi'`).get(id)?.state as string | undefined;
    return db.prepare(`SELECT s.state FROM bi_sources s JOIN bi_source_ownership o ON o.source_id=s.id
      WHERE s.id=? AND o.origin='telegram' AND o.agent_id=? AND o.account_id=? AND o.conversation_key=? AND o.binding_revision=?`)
      .get(id, origin.agentId, origin.accountId, origin.conversationKey, origin.bindingRevision)?.state as string | undefined;
  }

  status(origin: Destination, source: number) {
    return this.sourceState(source, origin);
  }

  summary(origin: Destination) {
    const row = this.storage.db.prepare(`SELECT count(*) AS total, count(*) FILTER(WHERE s.state='awaiting_review') AS complete
      FROM bi_sources s JOIN bi_source_ownership o ON o.source_id=s.id
      WHERE o.origin='telegram' AND o.agent_id=? AND o.account_id=? AND o.conversation_key=? AND o.binding_revision=?`)
      .get(origin.agentId, origin.accountId, origin.conversationKey, origin.bindingRevision);
    return { total: Number(row?.total), complete: Number(row?.complete) };
  }

  async intake(id: number, origin: Destination, text: string, file: IntakeFile | undefined, signal: AbortSignal, workId?: string) {
    if (origin.agentId !== 'bi' || origin.accountId !== 'telegram-bi') {
      throw new Error('Invalid BI intake owner');
    }
    const db = this.storage.db;
    let state = this.sourceState(id);
    if (state && !this.sourceState(id, origin)) return;
    if (!state) {
      const target = this.config('target');
      const isLink = !file && /^https?:\/\//i.test(text);
      const ref = file ? file.name.slice(0, 200) : isLink ? text : 'Telegram 文字';
      let bytes: Uint8Array | null = null;
      state = 'ready';
      let reason = '';
      try {
        if (file) {
          const extension = extname(ref).toLowerCase();
          if (!extensions.has(extension) || Number(file.size) > maxUpload) throw new Error('Unsupported file');
          bytes = await file.read(maxUpload, signal);
          if (!textExtensions.has(extension)) {
            state = 'blocked';
            reason = '原始檔已保存，請補充 UTF-8 文字供審核。';
          }
        } else if (isLink) {
          bytes = await readApprovedLink(ref, new Set(JSON.parse(this.config('origins') || '[]')), signal);
        } else if (text) bytes = Buffer.from(text);
        else throw new Error('Missing source');
      } catch {
        if (signal.aborted) return;
        state = 'blocked';
        reason = '無法讀取來源。請確認核准來源或上傳 UTF-8 補件。';
      }
      signal.throwIfAborted();
      this.storage.transaction(() => {
        const inserted = db.prepare('INSERT OR IGNORE INTO bi_sources(id,ref,state,reason,bytes,domain,target) VALUES (?,?,?,?,?,?,?)')
          .run(id, ref, state!, reason, bytes, this.config('domain') || 'telegram', target);
        if (inserted.changes) db.prepare(`INSERT INTO bi_source_ownership VALUES (?,?,?,'telegram',?,?,?,NULL,?,NULL)`)
          .run(id, legacyBiReviewKey(id), origin.agentId, origin.accountId, origin.conversationKey, origin.bindingRevision, workId ?? null);
      });
    }
    if (this.sourceState(id, origin) === 'ready') await this.stage(id, signal, workId);
    signal.throwIfAborted();
    return this.sourceState(id, origin);
  }

  async delegate(input: DelegatedSource, signal: AbortSignal, beforeRequest: () => void) {
    const db = this.storage.db;
    if (!this.proposal) throw new Error('BI proposal unavailable');
    const file = input.files.length === 1 ? input.files[0] : undefined;
    const link = !input.files.length && /^https:\/\/\S+$/i.test(input.task.trim()) ? input.task.trim() : undefined;
    let bytes = file?.data ?? null;
    let ready = Boolean(file && textExtensions.has(extname(file.name).toLowerCase()));
    if (link) {
      try {
        bytes = Buffer.from(await readApprovedLink(link, new Set(JSON.parse(this.config('origins') || '[]')), signal));
        ready = true;
      } catch { signal.throwIfAborted(); }
    }
    signal.throwIfAborted();
    const id = this.storage.transaction(() => {
      // Telegram source IDs use positive update IDs. Allocate delegation IDs separately in this DB.
      const id = Number(db.prepare('SELECT MIN(0,COALESCE(MIN(id),0))-1 AS id FROM bi_sources').get()?.id);
      db.prepare('INSERT INTO bi_sources(id,ref,state,reason,bytes,domain,target) VALUES (?,?,?,?,?,?,?)')
        .run(id, file?.name ?? link ?? '交辦來源', ready ? 'ready' : 'blocked', ready ? '' : '請提供可審核的 UTF-8 文字。',
          bytes, this.config('domain') || 'delegation', this.config('target'));
      db.prepare("INSERT INTO bi_source_ownership VALUES (?,?, 'bi','delegation',NULL,NULL,NULL,?,?,NULL)")
        .run(id, 'delegation-' + input.runId, input.id, input.workId);
      return id;
    });
    if (ready) await this.stageSource(id, signal, input.workId, (prompt, body, stop) =>
      this.proposal!.complete(prompt, body, stop, input.model, beforeRequest));
    return this.delegationReceipt(input.id, input.runId);
  }

  delegationSource(delegationId: string, runId: string) {
    const row = this.storage.db.prepare(`SELECT s.id,s.state,s.bytes IS NOT NULL AS hasFile FROM bi_source_ownership o
      JOIN bi_sources s ON s.id=o.source_id WHERE o.origin='delegation' AND o.agent_id='bi' AND o.delegation_id=? AND o.source_key=?`)
      .get(delegationId, 'delegation-' + runId);
    if (row) return { id: Number(row.id), state: String(row.state), hasFile: Boolean(row.hasFile) };
  }

  delegationReceipt(delegationId: string, runId: string) {
    const intake = this.delegationSource(delegationId, runId);
    if (!intake) return;
    const { id } = intake;
    const source = this.source(id)!;
    const job = String(source.source_key);
    const vault = String(source.target || `intake-${source.domain}-${id}`);
    if (this.proposal?.store.hasReview(job, vault, this.provenance(source))) {
      this.received(id, job);
      return { reviewId: job, sourceId: id };
    }
    if (source.state === 'blocked') return { sourceId: id };
  }

  validateSupplement(id: number, text: unknown) {
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000 || !Number.isSafeInteger(id)) {
      throw new Error('Invalid supplement');
    }
    return text;
  }

  canSupplement(id: number) { return this.sourceState(id) === 'blocked'; }

  supplement(id: number, text: unknown, signal: AbortSignal, origin?: Destination, workId?: string) {
    const supplement = this.validateSupplement(id, text);
    this.storage.transaction(() => {
      if (this.sourceState(id, origin) !== 'blocked') throw new Error('Source unavailable');
      this.storage.db.prepare("UPDATE bi_sources SET supplement=?,state='ready',reason='' WHERE id=?").run(Buffer.from(supplement), id);
      if (workId) this.recordWork(id, workId);
    });
    return this.stage(id, signal, workId);
  }

  private recordWork(id: number, workId: string) {
    this.storage.db.prepare("UPDATE bi_source_ownership SET work_id=? WHERE source_id=? AND agent_id='bi'").run(workId, id);
  }

  stage(id: number, signal: AbortSignal, workId?: string) {
    const pending = this.staging.get(id);
    if (pending) return pending;
    if (workId) this.recordWork(id, workId);
    const task = this.stageSource(id, signal, workId).finally(() => this.staging.delete(id));
    this.staging.set(id, task);
    return task;
  }

  private source(id: number) {
    return this.storage.db.prepare(`SELECT s.*,o.source_key,o.origin,o.account_id,o.conversation_key,o.binding_revision,o.work_id
      FROM bi_sources s JOIN bi_source_ownership o ON o.source_id=s.id
      WHERE s.id=? AND o.agent_id='bi'`).get(id);
  }

  private provenance(source: NonNullable<ReturnType<BiService['source']>>): BiProvenance {
    if (source.origin === 'delegation') {
      const sourceKey = String(source.source_key);
      return { origin: 'owner', sourceKey, runId: sourceKey.slice('delegation-'.length) };
    }
    return source.origin === 'telegram' ? { origin: 'telegram', sourceKey: String(source.source_key), destination: {
      accountId: String(source.account_id), conversationKey: String(source.conversation_key),
      bindingRevision: Number(source.binding_revision), agentId: 'bi',
    } } : { origin: 'legacy' };
  }

  private received(id: number, job: string) {
    this.storage.transaction(() => {
      this.storage.db.prepare("UPDATE bi_sources SET state='awaiting_review' WHERE id=?").run(id);
      this.storage.db.prepare('UPDATE bi_source_ownership SET review_id=? WHERE source_id=?').run(job, id);
    });
  }

  recover(id: number, workId: string) {
    const source = this.source(id);
    if (source?.work_id !== workId) return;
    if (source.state === 'blocked' || source.state === 'awaiting_review') return source.state;
    const store = this.proposal?.store;
    const job = String(source.source_key);
    if (source.target ? store?.hasReview(job, String(source.target), this.provenance(source)) : store?.biCompleted(job)) {
      this.received(id, job);
      return 'awaiting_review';
    }
  }

  stopUnverified(id: number, workId: string) {
    this.storage.db.prepare(`UPDATE bi_sources SET state='blocked',reason='工作結果已由擁有者處理。'
      WHERE id=? AND state='ready' AND EXISTS (SELECT 1 FROM bi_source_ownership WHERE source_id=? AND work_id=?)`).run(id, id, workId);
  }

  private async stageSource(id: number, signal: AbortSignal, workId?: string, complete = this.proposal?.complete) {
    const db = this.storage.db;
    const source = this.source(id);
    const proposal = this.proposal;
    if (source?.state !== 'ready' || !proposal || !complete) return;
    const { store } = proposal;
    const job = String(source.source_key);
    const vault = `intake-${source.domain}-${id}`;
    const provenance = this.provenance(source);
    try {
      signal.throwIfAborted();
      const text = new TextDecoder('utf-8', { fatal: true }).decode((source.supplement ?? source.bytes) as Uint8Array);
      if (!text.trim() || text.length > 100_000) throw new Error('Invalid UTF-8 source');
      if (source.target) {
        const target = String(source.target);
        if (!store.hasReview(job, target, provenance)) {
          const base = store.reviewBase(target);
          const bytes = Buffer.from(text);
          const hash = createHash('sha256').update(bytes).digest('hex');
          store.uploadReviewSource(hash, bytes);
          const result = await proposeReview(store, { id: job, vault: target, parent: base.parent,
            schema: base.schema.sha256, sha256: hash, ref: source.ref }, complete, signal, provenance);
          if ('rejected' in result) {
            db.prepare("UPDATE bi_sources SET state='blocked',reason=? WHERE id=?")
              .run('提案缺少可核對的原文引文，請補件後再試。', id);
            return;
          }
        }
        this.received(id, job);
        return;
      }
      const schema = store.installReviewSchema(vault, 'telegram-intake', '1', ['content']);
      store.enqueueBi(job, {
        vault: { id: vault, kind: 'bi', title: 'Telegram 收件 ' + id }, schema: schema.sha256,
        sources: [{ id: 'source', ref: String(source.ref), original: text, markdown: text }],
        cards: [{ id: 'record', type: 'record', key: 'record', title: 'Telegram 收件 ' + id, version: '1',
          fields: { content: text.slice(0, 4000) } }],
        evidence: [{ sourceId: 'source', cardId: 'record', field: 'content', start: 0, end: Math.min(text.length, 4000) }],
        relationships: [],
      }, provenance.origin, workId);
      store.runBi(job, provenance);
      if (store.biCompleted(job)) this.received(id, job);
    } catch {
      if (signal.aborted) return;
      db.prepare("UPDATE bi_sources SET state='blocked',reason=? WHERE id=?")
        .run(source.target ? '無法產生提案。請確認目標知識庫、模型及 UTF-8 補件。' : '請提供可審核的 UTF-8 文字。', id);
    }
  }
}
