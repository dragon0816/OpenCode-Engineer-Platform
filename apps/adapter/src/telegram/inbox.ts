import { DatabaseSync } from 'node:sqlite';

export type Bot = 'main' | 'bi';
export type Message = {
  from?: { id: number; is_bot?: boolean };
  chat: { id: number; type: string };
  message_thread_id?: number;
  text?: string;
  document?: { file_id: string; file_name?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number }[];
};
export type Update = { update_id: number; message?: Message };
export type Intake = { bot: Bot; id: number; topic: number; payload: string };

export class TelegramInbox {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cursor(bot TEXT PRIMARY KEY, next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(bot TEXT, id INTEGER, topic INTEGER NOT NULL,
        payload TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot,id));
      CREATE TABLE IF NOT EXISTS outbox(bot TEXT, id TEXT, topic INTEGER NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot,id));`);
    // A process can die after Telegram accepts a send and before SQLite records the reply.
    this.db.exec("UPDATE outbox SET state='indeterminate' WHERE state='sending'");
  }

  transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { work(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  offset(bot: Bot) {
    return Number(this.db.prepare('SELECT next FROM cursor WHERE bot=?').get(bot)?.next ?? 0);
  }

  admit(bot: Bot, owner: string, updates: Update[]) {
    this.transaction(() => {
      let next = this.offset(bot);
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid Telegram update');
        const message = update.message;
        if (message?.chat?.type === 'private' && String(message.chat.id) === owner &&
            String(message.from?.id) === owner && !message.from?.is_bot) {
          const { text, document, photo } = message;
          const topic = message.message_thread_id ?? 0;
          if (Number.isSafeInteger(topic) && topic >= 0) {
            this.db.prepare('INSERT OR IGNORE INTO inbox(bot,id,topic,payload) VALUES (?,?,?,?)')
              .run(bot, update.update_id, topic, JSON.stringify({ text, document, photo }));
          }
        }
        next = Math.max(next, update.update_id + 1);
      }
      this.db.prepare('INSERT INTO cursor VALUES (?,?) ON CONFLICT(bot) DO UPDATE SET next=excluded.next').run(bot, next);
    });
  }

  pending(bot: Bot) {
    return this.db.prepare('SELECT bot,id,topic,payload FROM inbox WHERE bot=? AND done=0 ORDER BY id LIMIT 1')
      .get(bot) as Intake | undefined;
  }

  notify(bot: Bot, id: string, topic: number, text: string) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(bot,id,topic,text) VALUES (?,?,?,?)').run(bot, id, topic, text);
  }

  notifyReviews(intents: readonly { review?: unknown }[]) {
    for (const { review } of intents) {
      this.notify('bi', 'review-' + review, 0, 'BI 審核已發布。請在工作台查看版本。');
    }
  }

  complete(row: Intake, text: string) {
    this.transaction(() => {
      this.notify(row.bot, 'update-' + row.id, row.topic, text);
      this.db.prepare('UPDATE inbox SET done=1 WHERE bot=? AND id=?').run(row.bot, row.id);
    });
  }
}
