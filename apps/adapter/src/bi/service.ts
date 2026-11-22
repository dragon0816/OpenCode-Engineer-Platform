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

export function biProposalServices(knowledge: Runtime['knowledge'], model: () => string | undefined): ProposalServices | undefined {
  if (!knowledge) return;
  const store = knowledge.reviewStore;
  return { complete: (prompt, input, signal) => knowledge.propose(prompt, input, signal, model()), store: {
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

  async intake(id: number, origin: Destination, text: string, file: IntakeFile | undefined, signal: AbortSignal) {
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
        if (inserted.changes) db.prepare(`INSERT INTO bi_source_ownership VALUES (?,?,?,'telegram',?,?,?,NULL,NULL,NULL)`)
          .run(id, legacyBiReviewKey(id), origin.agentId, origin.accountId, origin.conversationKey, origin.bindingRevision);
      });
    }
    if (this.sourceState(id, origin) === 'ready') await this.stage(id, signal);
    signal.throwIfAborted();
    return this.sourceState(id, origin);
  }

  supplement(id: number, text: unknown, signal: AbortSignal, origin?: Destination) {
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000 || !Number.isSafeInteger(id)) {
      throw new Error('Invalid supplement');
    }
    this.storage.transaction(() => {
      if (this.sourceState(id, origin) !== 'blocked') throw new Error('Source unavailable');
      this.storage.db.prepare("UPDATE bi_sources SET supplement=?,state='ready',reason='' WHERE id=?").run(Buffer.from(text), id);
    });
    return this.stage(id, signal);
  }

  stage(id: number, signal: AbortSignal) {
    const pending = this.staging.get(id);
    if (pending) return pending;
    const task = this.stageSource(id, signal).finally(() => this.staging.delete(id));
    this.staging.set(id, task);
    return task;
  }

  private async stageSource(id: number, signal: AbortSignal) {
    const db = this.storage.db;
    const source = db.prepare(`SELECT s.*,o.source_key,o.origin,o.account_id,o.conversation_key,o.binding_revision
      FROM bi_sources s JOIN bi_source_ownership o ON o.source_id=s.id
      WHERE s.id=? AND s.state='ready' AND o.agent_id='bi'`).get(id);
    const proposal = this.proposal;
    if (!source || !proposal) return;
    const { store } = proposal;
    const job = String(source.source_key);
    const vault = `intake-${source.domain}-${id}`;
    const provenance: BiProvenance = source.origin === 'telegram' ? { origin: 'telegram', sourceKey: job, destination: {
      accountId: String(source.account_id), conversationKey: String(source.conversation_key),
      bindingRevision: Number(source.binding_revision), agentId: 'bi',
    } } : { origin: 'legacy' };
    const received = () => this.storage.transaction(() => {
      db.prepare("UPDATE bi_sources SET state='awaiting_review' WHERE id=?").run(id);
      db.prepare('UPDATE bi_source_ownership SET review_id=? WHERE source_id=?').run(job, id);
    });
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
            schema: base.schema.sha256, sha256: hash, ref: source.ref }, proposal.complete, signal, provenance);
          if ('rejected' in result) {
            db.prepare("UPDATE bi_sources SET state='blocked',reason=? WHERE id=?")
              .run('提案缺少可核對的原文引文，請補件後再試。', id);
            return;
          }
        }
        received();
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
      }, provenance.origin);
      store.runBi(job, provenance);
      if (store.biCompleted(job)) received();
    } catch {
      if (signal.aborted) return;
      db.prepare("UPDATE bi_sources SET state='blocked',reason=? WHERE id=?")
        .run(source.target ? '無法產生提案。請確認目標知識庫、模型及 UTF-8 補件。' : '請提供可審核的 UTF-8 文字。', id);
    }
  }
}
