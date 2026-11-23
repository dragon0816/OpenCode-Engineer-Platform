import { createHash } from 'node:crypto';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { parseAsk } from '../../../../packages/knowledge/src/ask.ts';
import type { ChatService } from '../http/chat.ts';
import type { WebStore } from '../runs/web-store.ts';
import type { Intake, Message, TelegramInbox } from './inbox.ts';
import type { TelegramApi } from './poller.ts';
import { legacyBinding, topicKey } from './channel-migration.ts';
import { channelText, intakeStatus } from '../channels/catalog.ts';
import type { ChannelLocale, Destination } from '../channels/transport.ts';
import { BiService, biProposalServices } from '../bi/service.ts';
import { HttpError } from '../http/errors.ts';

export function turnId(accountId: string, update: number) {
  const hex = createHash('sha256').update(accountId + '-' + update).digest('hex').slice(0, 32);
  return hex.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

type Lease = { id: string; start: () => void; signal: AbortSignal };

export class TelegramRouter {
  private readonly inbox: TelegramInbox;
  private readonly chat: ChatService;
  private readonly sessions: WebStore;
  private readonly fileApi: (accountId: string) => TelegramApi | undefined;
  private readonly locale: (agentId: string) => ChannelLocale;
  private readonly externalSource: (agentId: string) => boolean;
  private readonly externalConfirmations = new Map<string, { text: string; digest: string; expires: number }>();
  readonly bi: BiService;

  constructor(inbox: TelegramInbox, runtime: Runtime, chat: ChatService, sessions: WebStore, biApi?: TelegramApi,
    locale: (agentId: string) => ChannelLocale = () => 'zh-TW', fileApi: (accountId: string) => TelegramApi | undefined = () => biApi,
    biModel: () => string | undefined = () => undefined, externalSource: (agentId: string) => boolean = () => false) {
    this.inbox = inbox;
    this.chat = chat;
    this.sessions = sessions;
    this.fileApi = fileApi;
    this.locale = locale;
    this.externalSource = externalSource;
    this.bi = new BiService(inbox, biProposalServices(runtime.knowledge, biModel));
  }

  async handle(row: Intake, signal: AbortSignal, lease?: Lease) {
    const message = JSON.parse(row.payload) as Message;
    const origin = row.destination ?? { ...legacyBinding(row.bot), conversationKey: topicKey(row.topic) };
    if (this.externalSource(origin.agentId)) {
      const file = message.document ?? message.photo?.at(-1);
      if (file) return channelText(this.locale(origin.agentId)).externalAttachment(message.document?.file_name ?? 'photo.jpg');
      return this.chatMessage(row, origin, message.text ?? '', signal, lease, true);
    }
    if (row.bot === 'main') return this.chatMessage(row, origin, message.text ?? '', signal, lease);
    const locale = this.locale(origin.agentId);
    const messages = channelText(locale);
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
      try { await this.bi.supplement(id, supplement[2], signal, origin, lease?.id); }
      catch { return messages.sourceUnavailable; }
      return intakeStatus(locale, id, this.bi.status(origin, id));
    }
    if (/^\/(?:publish|approve|reject|rollback|reactivate)(?:\s|$)/i.test(text)) return messages.ownerAction;
    const file = message.document ?? message.photo?.at(-1);
    const client = this.fileApi(origin.accountId);
    const attachment = file && {
      name: message.document ? message.document.file_name ?? 'attachment' : 'photo.jpg', size: file.file_size,
      read: (limit: number, stop: AbortSignal) => {
        if (!client) throw new Error('Telegram file unavailable');
        return client.file(file.file_id, limit, stop);
      },
    };
    const state = await this.bi.intake(row.id, origin, text, attachment, signal, lease?.id);
    if (state === 'ready' || signal.aborted) return;
    return intakeStatus(locale, row.id, state);
  }

  private async chatMessage(row: Intake, owner: Destination, text: string, signal: AbortSignal, lease?: Lease, external = false) {
    const messages = channelText(this.locale(owner.agentId));
    if (!text.trim()) return messages.empty;
    const db = this.inbox.db;
    const binding = this.inbox.conversation(owner, owner.conversationKey);
    let session = this.sessions.sessions().find(({ id }) => id === binding?.session);
    if (/^\/ask(?:\s|$)/.test(text)) {
      const match = text.match(/^\/ask\s+(\S+)\s+([\s\S]+)$/);
      const input = match && parseAsk({ vault: match[1], question: match[2] });
      if (!input) return messages.askUsage;
      const result = !binding || session
        ? await this.chat.askKnowledge(input, AbortSignal.any([signal, AbortSignal.timeout(76_000)]), session, owner)
        : undefined;
      if (result?.state !== 'verified') return messages.askUnavailable;
      return result.citations.map(({ quote, sourceId, sourceVersion, passageID }) =>
        messages.citation(quote, `${sourceId} · ${sourceVersion} · ${passageID}`)).join('\n\n').slice(0, 4000);
    }
    if (session) {
      const previous = this.sessions.turns(session.id).at(-1);
      if (previous && previous.state !== 'verified' && previous.state !== 'failed' && previous.state !== 'cancelled') {
        const failed = db.prepare(`SELECT event_key FROM channel_inbound WHERE account_id=? AND conversation_key=?
          AND binding_revision=? AND lane='work' AND status='failed'`).all(owner.accountId, owner.conversationKey, owner.bindingRevision);
        if (failed.some(({ event_key }) => previous.id === turnId(owner.accountId, Number(event_key)))) session = undefined;
      }
    }
    if (!session) {
      session = await this.chat.create('inspector', undefined, undefined, owner);
      signal.throwIfAborted();
      this.inbox.rememberConversation(owner, owner.conversationKey, session.id);
    }
    const id = turnId(owner.accountId, row.id);
    const confirmationKey = JSON.stringify([owner.accountId, owner.bindingRevision, owner.conversationKey, session.id]);
    let digest: string | undefined;
    if (external) {
      for (const [key, entry] of this.externalConfirmations) if (entry.expires <= Date.now()) this.externalConfirmations.delete(key);
      const pending = this.externalConfirmations.get(confirmationKey);
      this.externalConfirmations.delete(confirmationKey);
      if (text.trim() === '/confirm') {
        if (!pending) return messages.externalNoConfirmation;
        ({ text, digest } = pending);
      }
    }
    try {
      await this.chat.submit(session, { id, text, attachments: [], workbook: false, ...(digest && { externalConfirmation: digest }) },
        undefined, owner, lease);
    } catch (error) {
      if (!external || !(error instanceof HttpError)) throw error;
      if (error.detail.code === 'external-confirm-turn' && typeof error.detail.params?.digest === 'string') {
        this.externalConfirmations.set(confirmationKey, { text, digest: error.detail.params.digest, expires: Date.now() + 300_000 });
        return messages.externalConfirm;
      }
      return messages.externalIssue(error.detail.code, String(error.detail.params?.name ?? ''), error.detail.text);
    }
    return this.turnReply(session, id, owner, signal);
  }

  async recoveredReply(row: Intake, signal: AbortSignal) {
    const owner = row.destination!;
    const mapping = this.inbox.conversation(owner, owner.conversationKey);
    const session = this.sessions.sessions(true).find(({ id }) => id === mapping?.session);
    if (session) return this.turnReply(session, turnId(owner.accountId, row.id), owner, signal);
  }

  private async turnReply(session: ReturnType<WebStore['sessions']>[number], id: string, owner: Destination, signal: AbortSignal) {
    const messages = channelText(this.locale(owner.agentId));
    const state = await this.chat.state(session);
    signal.throwIfAborted();
    const run = state.runs.find((item) => item.id === id);
    if (run?.state === 'cancelled') return messages.cancelled;
    if (run?.state === 'failed') return run.errorDetail && this.sessions.get(id).external
      ? messages.externalIssue(run.errorDetail.code, String(run.errorDetail.params?.name ?? ''), run.errorDetail.text) : messages.failed;
    if (run?.state !== 'verified') return undefined;
    if (!state.messages) return undefined;
    const index = state.messages.findIndex((message) => message.id === this.sessions.get(id).submissionID);
    if (index < 0) return undefined;
    const result = [];
    for (const message of state.messages.slice(index + 1)) {
      if (message.role !== 'assistant') break;
      if (message.text.trim()) result.push(message.text);
    }
    return result.join('\n').slice(0, 4000) || messages.completed;
  }
}
