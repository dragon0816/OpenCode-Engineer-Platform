import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { readApprovedLink } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import { key } from '../../../../packages/knowledge/src/ingest.ts';
import { parseAsk } from '../../../../packages/knowledge/src/ask.ts';
import { maxUpload } from '../runs/attachments.ts';
import type { ChatService } from '../http/chat.ts';
import type { WebStore } from '../runs/web-store.ts';
import type { Intake, Message, TelegramInbox } from './inbox.ts';
import type { TelegramApi } from './poller.ts';

const extensions = new Set(['.txt', '.md', '.csv', '.png', '.jpg', '.jpeg', '.pdf', '.xlsx']);
const textExtensions = new Set(['.txt', '.md', '.csv']);

export class TelegramRouter {
  private readonly inbox: TelegramInbox;
  private readonly runtime: Runtime;
  private readonly chat: ChatService;
  private readonly sessions: WebStore;
  private readonly biApi?: TelegramApi;

  constructor(inbox: TelegramInbox, runtime: Runtime, chat: ChatService, sessions: WebStore, biApi?: TelegramApi) {
    this.inbox = inbox;
    this.runtime = runtime;
    this.chat = chat;
    this.sessions = sessions;
    this.biApi = biApi;
    inbox.db.exec(`CREATE TABLE IF NOT EXISTS telegram_sessions(topic INTEGER PRIMARY KEY, session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bi_sources(id INTEGER PRIMARY KEY, ref TEXT NOT NULL, state TEXT NOT NULL,
      reason TEXT NOT NULL, bytes BLOB, domain TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bi_config(name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!inbox.db.prepare('PRAGMA table_info(bi_sources)').all().some((column) => column.name === 'supplement')) {
      inbox.db.exec('ALTER TABLE bi_sources ADD COLUMN supplement BLOB');
    }
  }

  config(name: string) {
    return String(this.inbox.db.prepare('SELECT value FROM bi_config WHERE name=?').get(name)?.value ?? '');
  }

  configure(domain: unknown, origins: unknown) {
    const name = key(domain);
    if (name.length > 60 || !Array.isArray(origins) || origins.length > 30) throw new Error('Invalid inbox settings');
    const approved = origins.map((origin) => {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid approved source');
      return url.origin;
    });
    this.inbox.transaction(() => {
      const save = this.inbox.db.prepare('INSERT INTO bi_config VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
      save.run('domain', name);
      save.run('origins', JSON.stringify(approved));
    });
  }

  async handle(row: Intake, signal: AbortSignal) {
    const message = JSON.parse(row.payload) as Message;
    if (row.bot === 'main') return this.main(row, message.text ?? '', signal);
    if (message.text?.trim() === '/status') {
      const jobs = this.runtime.knowledge?.reviewStore.reconciliation().jobs ?? [];
      return `BI 工作共 ${jobs.length} 筆，已送審 ${jobs.filter((job) => job.completed).length} 筆。`;
    }
    return this.intake(row.id, message, signal);
  }

  private async main(row: Intake, text: string, signal: AbortSignal) {
    if (!text.trim()) return '請輸入文字訊息。';
    if (/^\/ask(?:\s|$)/.test(text)) {
      const match = text.match(/^\/ask\s+(\S+)\s+([\s\S]+)$/);
      const input = match && parseAsk({ vault: match[1], question: match[2] });
      if (!input) return '請輸入 /ask 知識庫ID 問題';
      const result = await this.runtime.knowledge?.ask.ask(input, AbortSignal.any([signal, AbortSignal.timeout(76_000)]));
      if (result?.state !== 'verified') return '沒有可核對的知識答案。請確認知識庫及模型授權。';
      return result.citations.map(({ quote, sourceId, sourceVersion, passageID }) =>
        `「${quote}」\n來源 ${sourceId} · ${sourceVersion} · ${passageID}`).join('\n\n').slice(0, 4000);
    }
    const db = this.inbox.db;
    const binding = db.prepare('SELECT session FROM telegram_sessions WHERE topic=?').get(row.topic);
    let session = this.sessions.sessions().find(({ id }) => id === binding?.session);
    if (!session) {
      session = await this.chat.create('inspector');
      db.prepare('INSERT OR REPLACE INTO telegram_sessions VALUES (?,?)').run(row.topic, session.id);
    }
    const hex = createHash('sha256').update('telegram-main-' + row.id).digest('hex').slice(0, 32);
    const id = hex.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
    this.chat.submit(session, { id, text, attachments: [], workbook: false });
    const state = await this.chat.state(session);
    const run = state.runs.find((item) => item.id === id);
    if (run?.state === 'failed') return '對話未完成，請在工作台確認服務狀態。';
    if (run?.state !== 'verified') return undefined;
    if (!state.messages) return undefined;
    const index = state.messages.findIndex((message) => message.id === this.sessions.get(id).submissionID);
    if (index < 0) return undefined;
    const result = [];
    for (const message of state.messages.slice(index + 1)) {
      if (message.role !== 'assistant') break;
      result.push(message.text);
    }
    return result.join('\n').slice(0, 4000) || '對話已完成。';
  }

  private async intake(id: number, message: Message, signal: AbortSignal) {
    const db = this.inbox.db;
    let existing = db.prepare('SELECT state FROM bi_sources WHERE id=?').get(id);
    if (!existing) {
      const file = message.document ?? message.photo?.at(-1);
      const text = message.text?.trim() ?? '';
      const ref = file ? (message.document ? message.document.file_name ?? 'attachment' : 'photo.jpg').slice(0, 200) :
        /^https?:\/\//i.test(text) ? text : 'Telegram 文字';
      let bytes: Buffer | null = null;
      let state = 'ready';
      let reason = '';
      try {
        if (file) {
          if (!this.biApi || !extensions.has(extname(ref).toLowerCase()) || Number(file.file_size) > maxUpload) {
            throw new Error('Unsupported file');
          }
          bytes = await this.biApi.file(file.file_id, maxUpload, signal);
          if (!textExtensions.has(extname(ref).toLowerCase())) {
            state = 'blocked';
            reason = '原始檔已保存，請補充 UTF-8 文字供審核。';
          }
        } else if (ref !== 'Telegram 文字') {
          bytes = await readApprovedLink(ref, new Set(JSON.parse(this.config('origins') || '[]')), signal);
        } else if (text) bytes = Buffer.from(text);
        else throw new Error('Missing source');
      } catch {
        if (signal.aborted) return undefined;
        state = 'blocked';
        reason = '無法讀取來源。請確認核准來源或上傳 UTF-8 補件。';
      }
      db.prepare('INSERT OR IGNORE INTO bi_sources(id,ref,state,reason,bytes,domain) VALUES (?,?,?,?,?,?)')
        .run(id, ref, state, reason, bytes, this.config('domain') || 'telegram');
      existing = { state };
    }
    if (existing.state === 'ready') this.stage(id);
    const status = db.prepare('SELECT state FROM bi_sources WHERE id=?').get(id)?.state;
    if (status === 'ready') return undefined;
    return status === 'awaiting_review' ? `收件 ${id} 已送審。` : `收件 ${id} 需要補件，請開啟工作台。`;
  }

  supplement(id: number, text: unknown) {
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000 || !Number.isSafeInteger(id)) {
      throw new Error('Invalid supplement');
    }
    const result = this.inbox.db.prepare("UPDATE bi_sources SET supplement=?,state='ready',reason='' WHERE id=? AND state='blocked'")
      .run(Buffer.from(text), id);
    if (!result.changes) throw new Error('Source unavailable');
    this.stage(id);
  }

  stage(id: number) {
    const db = this.inbox.db;
    const source = db.prepare("SELECT * FROM bi_sources WHERE id=? AND state='ready'").get(id);
    const store = this.runtime.knowledge?.reviewStore;
    if (!source || !store) return;
    const job = 'telegram-bi-' + id;
    const vault = `intake-${source.domain}-${id}`;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode((source.supplement ?? source.bytes) as Uint8Array);
      if (!text.trim() || text.length > 100_000) throw new Error('Invalid UTF-8 source');
      const schema = store.installReviewSchema(vault, 'telegram-intake', '1', ['content']);
      store.enqueueBi(job, {
        vault: { id: vault, kind: 'bi', title: 'Telegram 收件 ' + id }, schema: schema.sha256,
        sources: [{ id: 'source', ref: String(source.ref), original: text, markdown: text }],
        cards: [{ id: 'record', type: 'record', key: 'record', title: 'Telegram 收件 ' + id, version: '1',
          fields: { content: text.slice(0, 4000) } }],
        evidence: [{ sourceId: 'source', cardId: 'record', field: 'content', start: 0, end: Math.min(text.length, 4000) }],
        relationships: [],
      });
      store.runBi(job);
      if (store.biCompleted(job)) db.prepare("UPDATE bi_sources SET state='awaiting_review' WHERE id=?").run(id);
    } catch {
      db.prepare("UPDATE bi_sources SET state='blocked',reason='請提供可審核的 UTF-8 文字。' WHERE id=?").run(id);
    }
  }
}
