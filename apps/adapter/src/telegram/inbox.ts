import { DatabaseSync } from 'node:sqlite';
import { ChannelSpool } from '../channels/spool.ts';
import type { Binding, ChannelLocale, Destination, InboundEnvelope, Lane } from '../channels/transport.ts';
import { channelText } from '../channels/catalog.ts';
import { verifyBiSourceOwners } from '../bi/source-ownership.ts';
import { checkTelegramSchema, legacyBinding, migrateTelegramSpool, telegramLane, topicKey } from './channel-migration.ts';
import type { Bot } from './channel-migration.ts';

export { telegramInboxVersion } from './channel-migration.ts';
export type { Bot } from './channel-migration.ts';
export type { Lane } from '../channels/transport.ts';
export type Message = {
  from?: { id: number; is_bot?: boolean };
  chat: { id: number; type: string };
  message_thread_id?: number;
  text?: string;
  document?: { file_id: string; file_name?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number }[];
};
export type Update = { update_id: number; message?: Message };
export type Intake = { bot: Bot; id: number; topic: number; payload: string; destination?: Destination };

export function telegramBatch(bot: Bot, owner: string, updates: Update[], checkpoint: string, now: number, legacy = true) {
  let next = Number(checkpoint || 0);
  const events: InboundEnvelope[] = [];
  for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id === Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid Telegram update');
    }
    next = Math.max(next, update.update_id + 1);
    const eventKey = String(update.update_id);
    const message = update.message;
    const topic = message?.message_thread_id ?? 0;
    const authorized = message?.chat?.type === 'private' && String(message.chat.id) === owner &&
      String(message.from?.id) === owner && !message.from?.is_bot && Number.isSafeInteger(topic) && topic >= 0;
    if (!authorized) {
      events.push({ eventKey, receivedAt: now, conversationKey: '', lane: 'work', reasonCode: 'unauthorized-update' });
      continue;
    }
    const { text, document, photo } = message;
    const conversationKey = legacy ? topicKey(topic) : `chat:${owner}:${topicKey(topic)}`;
    events.push({ eventKey, receivedAt: now, conversationKey, lane: telegramLane(bot, text),
      payload: { text, document, photo } });
  }
  return { events, nextCheckpoint: String(next) };
}

export class TelegramInbox extends ChannelSpool {
  readonly db: DatabaseSync;

  constructor(path: string, recoverSending = true) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    super(db);
    this.db = db;
    try {
      checkTelegramSchema(db);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      this.transaction(() => {
        migrateTelegramSpool(db, path);
        verifyBiSourceOwners(db);
      });
      // A process can die after Telegram accepts a send and before SQLite records the reply.
      if (recoverSending) this.recoverSending();
    } catch (error) {
      db.close();
      throw error;
    }
  }

  offset(bot: Bot) {
    return Number(this.checkpoint(legacyBinding(bot).accountId));
  }

  admit(bot: Bot, owner: string, updates: Update[], now = Date.now()) {
    const binding = legacyBinding(bot);
    const checkpoint = this.checkpoint(binding.accountId);
    const { events, nextCheckpoint } = telegramBatch(bot, owner, updates, checkpoint, now);
    this.admitBatch(binding, events, nextCheckpoint, now, checkpoint);
  }

  next(bot: Bot, lane: Lane, now: number) {
    const row = this.nextInbound(legacyBinding(bot), lane, now);
    if (!row) return;
    return { bot, id: Number(row.eventKey), topic: Number(row.conversationKey.slice('topic:'.length)),
      payload: row.payload, started: row.started, attempts: row.attempts };
  }

  nextBound(bot: Bot, binding: Binding, lane: Lane, now: number) {
    const row = this.nextInbound(binding, lane, now);
    if (!row) return;
    const { conversationKey } = row;
    return { bot, id: Number(row.eventKey), topic: Number(conversationKey.split(':').at(-1)), payload: row.payload,
      started: row.started, attempts: row.attempts, destination: { ...binding, conversationKey } };
  }

  attempt(row: Intake, now: number, due: number) {
    this.attemptInbound({ accountId: row.destination?.accountId ?? legacyBinding(row.bot).accountId, eventKey: String(row.id) }, now, due);
  }

  notify(bot: Bot, id: string, topic: number, text: string, locale: ChannelLocale = 'zh-TW') {
    this.enqueueOutbound({ ...legacyBinding(bot), conversationKey: topicKey(topic), effectKey: id, locale, text });
  }

  notifyReviews(intents: readonly { review?: unknown; destination?: unknown; sourceKey?: unknown }[], locale: ChannelLocale = 'zh-TW') {
    const find = this.db.prepare(`SELECT account_id AS accountId, conversation_key AS conversationKey,
      binding_revision AS bindingRevision, agent_id AS agentId FROM bi_source_ownership
      WHERE source_key=? AND origin='telegram' AND agent_id='bi'`);
    for (const { review, destination: receipt, sourceKey } of intents) {
      if (typeof review !== 'string') continue;
      const destination = typeof sourceKey === 'string' ? find.get(sourceKey) as Destination | undefined : undefined;
      if (receipt && (!destination || receipt !== JSON.stringify(destination))) continue;
      const message = { effectKey: 'review-' + review, text: channelText(locale).published, locale };
      // Historical intents without a known destination used the original BI bot's default topic.
      this.enqueueOutbound({ ...(destination ?? { ...legacyBinding('bi'), conversationKey: topicKey(0) }), ...message });
    }
  }

  resend(bot: unknown, id: unknown) {
    if ((bot !== 'main' && bot !== 'bi') || typeof id !== 'string') throw new Error('Delivery is unavailable for resend');
    this.retryOutbound(legacyBinding(bot).accountId, id);
  }

  complete(row: Intake, text: string, failed = false, locale: ChannelLocale = 'zh-TW') {
    const destination = row.destination ?? { ...legacyBinding(row.bot), conversationKey: topicKey(row.topic) };
    this.completeInbound(String(row.id), { ...destination,
      effectKey: 'update-' + row.id, locale, text }, failed);
  }

  conversation(binding: Binding, conversationKey: string) {
    return this.db.prepare(`SELECT session_id AS session FROM channel_conversations
      WHERE account_id=? AND conversation_key=? AND binding_revision=? AND agent_id=?`)
      .get(binding.accountId, conversationKey, binding.bindingRevision, binding.agentId);
  }

  rememberConversation(binding: Binding, conversationKey: string, session: string) {
    this.db.prepare(`INSERT INTO channel_conversations VALUES (?,?,?,?,?)
      ON CONFLICT(account_id,conversation_key,binding_revision) DO UPDATE SET session_id=excluded.session_id
      WHERE channel_conversations.agent_id=excluded.agent_id`)
      .run(binding.accountId, conversationKey, binding.bindingRevision, binding.agentId, session);
  }
}
