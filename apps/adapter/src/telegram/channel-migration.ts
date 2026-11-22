import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { channelSpoolSchema } from '../channels/spool.ts';

export const telegramInboxVersion = 2;
export type Bot = 'main' | 'bi';
export const legacyBinding = (bot: Bot) => ({ accountId: 'telegram-' + bot, agentId: bot, bindingRevision: 1 });
export const topicKey = (topic: number) => 'topic:' + topic;

const historicalSchema = `
  CREATE TABLE IF NOT EXISTS cursor(bot TEXT PRIMARY KEY, next INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS inbox(bot TEXT, id INTEGER, topic INTEGER NOT NULL,
    payload TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot,id));
  CREATE TABLE IF NOT EXISTS outbox(bot TEXT, id TEXT, topic INTEGER NOT NULL, text TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot,id));
  CREATE TABLE IF NOT EXISTS telegram_binding(bot TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS telegram_sessions(topic INTEGER PRIMARY KEY, session TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bi_sources(id INTEGER PRIMARY KEY, ref TEXT NOT NULL, state TEXT NOT NULL,
    reason TEXT NOT NULL, bytes BLOB, domain TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bi_config(name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bi_schedules(id TEXT PRIMARY KEY, zone TEXT, time TEXT,
    payload TEXT, state TEXT, since INTEGER);
  CREATE TABLE IF NOT EXISTS bi_occurrences(schedule TEXT, wall TEXT, zone TEXT, utc INTEGER, job TEXT UNIQUE,
    payload TEXT, state TEXT, PRIMARY KEY(schedule,wall));
`;

export const legacyTelegramTables = ['cursor', 'inbox', 'outbox', 'telegram_binding', 'telegram_sessions',
  'bi_sources', 'bi_config', 'bi_schedules', 'bi_occurrences'];

export function telegramLane(bot: Bot, text: unknown) {
  return typeof text === 'string' &&
    (bot === 'main' ? /^\/ask(?:\s|$)/.test(text) : text.trim() === '/status') ? 'command' : 'work';
}

const hasTable = (db: DatabaseSync, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const hasColumn = (db: DatabaseSync, table: string, name: string) =>
  Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(table, name));

function botOf(value: unknown): Bot {
  if (value === 'main' || value === 'bi') return value;
  throw new Error('Invalid legacy Telegram account');
}

function integer(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error('Invalid legacy Telegram number');
}

function* legacyRows(db: DatabaseSync, table: string, order = 'rowid') {
  if (hasTable(db, table)) yield* db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate();
}

// Keep this projection read-only so upgrade reconciliation can compute expected values from the backup.
export function* legacyChannelRows(db: DatabaseSync, table: string): Generator<SQLInputValue[]> {
  switch (table) {
    case 'channel_cursors':
      for (const row of legacyRows(db, 'cursor')) {
        if (row.bot === 'scheduler') continue;
        yield [legacyBinding(botOf(row.bot)).accountId, String(integer(row.next)), 0];
      }
      break;
    case 'channel_inbound':
      for (const row of legacyRows(db, 'inbox', 'bot,id')) {
        const bot = botOf(row.bot);
        const status = row.failed ? 'failed' : row.done ? 'handled' : 'pending';
        const payload = String(row.payload);
        yield [legacyBinding(bot).accountId, String(integer(row.id)), topicKey(integer(row.topic)), 1, bot,
          row.firstSeen ?? 0, row.started ?? null, status, payload, row.attempts ?? 0, row.due ?? 0, null,
          status === 'failed' ? 'intake-deadline' : null, row.lane ?? telegramLane(bot, JSON.parse(payload).text)];
      }
      break;
    case 'channel_outbound':
      for (const row of legacyRows(db, 'outbox')) {
        const bot = botOf(row.bot);
        yield [legacyBinding(bot).accountId, row.id, topicKey(integer(row.topic)), 1, bot,
          JSON.stringify({ text: row.text, locale: 'zh-TW' }), row.state, row.attempts, row.due, null, null];
      }
      break;
    case 'channel_conversations':
      for (const row of legacyRows(db, 'telegram_sessions')) {
        yield ['telegram-main', topicKey(integer(row.topic)), 1, 'main', row.session];
      }
      break;
    default: throw new Error('Unknown channel migration table');
  }
}

export const migratedChannelTables = ['channel_cursors', 'channel_inbound', 'channel_outbound', 'channel_conversations'];

export function verifyChannelConversations(db: DatabaseSync, sessions?: DatabaseSync) {
  const find = sessions?.prepare(`SELECT 1 FROM session_ownership WHERE session_id=? AND agent_id=?
    AND origin='channel' AND channel_account_id=? AND conversation_key=? AND binding_revision=?`);
  for (const row of db.prepare('SELECT * FROM channel_conversations').iterate()) {
    if (!find?.get(row.session_id, row.agent_id, row.account_id, row.conversation_key, row.binding_revision)) {
      throw new Error('Channel conversation ownership is invalid');
    }
  }
}

export function migrateTelegramSpool(db: DatabaseSync) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > telegramInboxVersion || version < 0) throw new Error('Telegram 資料庫版本不相容。');
  if (version === telegramInboxVersion) return;
  db.exec(historicalSchema);
  db.exec(channelSpoolSchema);
  for (const table of migratedChannelTables) {
    let insert;
    for (const row of legacyChannelRows(db, table)) {
      insert ??= db.prepare(`INSERT INTO ${table} VALUES (${row.map(() => '?').join(',')})`);
      insert.run(...row);
    }
  }
  if (!hasColumn(db, 'bi_sources', 'supplement')) db.exec('ALTER TABLE bi_sources ADD COLUMN supplement BLOB');
  if (!hasColumn(db, 'bi_sources', 'target')) db.exec("ALTER TABLE bi_sources ADD COLUMN target TEXT NOT NULL DEFAULT ''");
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Telegram foreign keys are invalid');
  db.exec(`PRAGMA user_version=${telegramInboxVersion}`);
}
