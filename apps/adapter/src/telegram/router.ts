import { createHash } from 'node:crypto';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { parseAsk } from '../../../../packages/knowledge/src/ask.ts';
import type { ChatService } from '../http/chat.ts';
import type { WebStore } from '../runs/web-store.ts';
import type { Bot, Intake, Message, TelegramInbox } from './inbox.ts';
import type { TelegramApi } from './poller.ts';
import { legacyBinding, topicKey } from './channel-migration.ts';
import { channelText, intakeStatus } from '../channels/catalog.ts';
import type { ChannelLocale } from '../channels/transport.ts';
import { BiService, biProposalServices } from '../bi/service.ts';

function turnId(update: number) {
  const hex = createHash('sha256').update('telegram-main-' + update).digest('hex').slice(0, 32);
  return hex.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

export class TelegramRouter {
  private readonly inbox: TelegramInbox;
  private readonly chat: ChatService;
  private readonly sessions: WebStore;
  private readonly fileApi: (bot: Bot) => TelegramApi | undefined;
  private readonly locale: (bot: Bot) => ChannelLocale;
  readonly bi: BiService;

  constructor(inbox: TelegramInbox, runtime: Runtime, chat: ChatService, sessions: WebStore, biApi?: TelegramApi,
    locale: (bot: Bot) => ChannelLocale = () => 'zh-TW', fileApi: (bot: Bot) => TelegramApi | undefined = () => biApi,
    biModel: () => string | undefined = () => undefined) {
    this.inbox = inbox;
    this.chat = chat;
    this.sessions = sessions;
    this.fileApi = fileApi;
    this.locale = locale;
    this.bi = new BiService(inbox, biProposalServices(runtime.knowledge, biModel));
  }

  async handle(row: Intake, signal: AbortSignal) {
    const message = JSON.parse(row.payload) as Message;
    if (row.bot === 'main') return this.main(row, message.text ?? '', signal);
    const locale = this.locale(row.bot);
    const messages = channelText(locale);
    const origin = { ...legacyBinding(row.bot), conversationKey: topicKey(row.topic) };
    const text = message.text?.trim() ?? '';
    if (text === '/status') {
      const status = this.bi.summary(origin);
      return messages.status(status.total, status.complete);
    }
    if (/^\/status(?:\s|$)/.test(text)) {
      const id = Number(text.match(/^\/status\s+(\d+)$/)?.[1]);
      return intakeStatus(locale, id, Number.isSafeInteger(id) ? this.bi.status(origin, id) : undefined);
    }
    if (/^\/supplement(?:\s|$)/.test(text)) {
      const supplement = text.match(/^\/supplement\s+(\d+)\s+([\s\S]+)$/);
      if (!supplement) return messages.supplementUsage;
      const id = Number(supplement[1]);
      try { await this.bi.supplement(id, supplement[2], signal, origin); }
      catch { return messages.sourceUnavailable; }
      return intakeStatus(locale, id, this.bi.status(origin, id));
    }
    if (/^\/(?:publish|approve|reject|rollback|reactivate)(?:\s|$)/i.test(text)) return messages.ownerAction;
    const file = message.document ?? message.photo?.at(-1);
    const client = this.fileApi(row.bot);
    const attachment = file && {
      name: message.document ? message.document.file_name ?? 'attachment' : 'photo.jpg', size: file.file_size,
      read: (limit: number, stop: AbortSignal) => {
        if (!client) throw new Error('Telegram file unavailable');
        return client.file(file.file_id, limit, stop);
      },
    };
    const state = await this.bi.intake(row.id, origin, text, attachment, signal);
    if (state === 'ready' || signal.aborted) return;
    return intakeStatus(locale, row.id, state);
  }

  private async main(row: Intake, text: string, signal: AbortSignal) {
    const messages = channelText(this.locale(row.bot));
    if (!text.trim()) return messages.empty;
    const db = this.inbox.db;
    const owner = legacyBinding('main');
    const binding = this.inbox.conversation(owner, row.topic);
    let session = this.sessions.sessions().find(({ id }) => id === binding?.session);
    if (/^\/ask(?:\s|$)/.test(text)) {
      const match = text.match(/^\/ask\s+(\S+)\s+([\s\S]+)$/);
      const input = match && parseAsk({ vault: match[1], question: match[2] });
      if (!input) return messages.askUsage;
      const result = !binding || session
        ? await this.chat.askKnowledge(input, AbortSignal.any([signal, AbortSignal.timeout(76_000)]), session, row.topic)
        : undefined;
      if (result?.state !== 'verified') return messages.askUnavailable;
      return result.citations.map(({ quote, sourceId, sourceVersion, passageID }) =>
        messages.citation(quote, `${sourceId} · ${sourceVersion} · ${passageID}`)).join('\n\n').slice(0, 4000);
    }
    if (session) {
      const previous = this.sessions.turns(session.id).at(-1);
      if (previous && previous.state !== 'verified' && previous.state !== 'failed' && previous.state !== 'cancelled') {
        const failed = db.prepare(`SELECT event_key FROM channel_inbound WHERE account_id=? AND conversation_key=?
          AND binding_revision=? AND lane='work' AND status='failed'`).all(owner.accountId, topicKey(row.topic), owner.bindingRevision);
        if (failed.some(({ event_key }) => previous.id === turnId(Number(event_key)))) session = undefined;
      }
    }
    if (!session) {
      session = await this.chat.create('inspector', undefined, undefined, row.topic);
      signal.throwIfAborted();
      this.inbox.rememberConversation(owner, row.topic, session.id);
    }
    const id = turnId(row.id);
    await this.chat.submit(session, { id, text, attachments: [], workbook: false }, undefined, row.topic);
    const state = await this.chat.state(session);
    signal.throwIfAborted();
    const run = state.runs.find((item) => item.id === id);
    if (run?.state === 'cancelled') return messages.cancelled;
    if (run?.state === 'failed') return messages.failed;
    if (run?.state !== 'verified') return undefined;
    if (!state.messages) return undefined;
    const index = state.messages.findIndex((message) => message.id === this.sessions.get(id).submissionID);
    if (index < 0) return undefined;
    const result = [];
    for (const message of state.messages.slice(index + 1)) {
      if (message.role !== 'assistant') break;
      result.push(message.text);
    }
    return result.join('\n').slice(0, 4000) || messages.completed;
  }
}
