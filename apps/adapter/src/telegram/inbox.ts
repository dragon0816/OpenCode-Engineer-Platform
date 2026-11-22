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
export type Lane = 'work' | 'command';
export const telegramInboxVersion = 1;
const laneOf = (bot: Bot, text: unknown): Lane => typeof text === 'string' &&
  (bot === 'main' ? /^\/ask(?:\s|$)/.test(text) : text.trim() === '/status') ? 'command' : 'work';

export class TelegramInbox {
  readonly db: DatabaseSync;

  constructor(path: string, recoverSending = true) {
    this.db = new DatabaseSync(path);
    try {
      this.migrate();
      // A process can die after Telegram accepts a send and before SQLite records the reply.
      if (recoverSending) this.db.exec("UPDATE outbox SET state='indeterminate' WHERE state='sending'");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate() {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > telegramInboxVersion) throw new Error('Telegram 資料庫版本比程式新。請使用新版程式或先回退資料。');
    if (version < 0) throw new Error('Telegram 資料庫版本無效。');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    if (version === telegramInboxVersion) return;
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS cursor(bot TEXT PRIMARY KEY, next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(bot TEXT, id INTEGER, topic INTEGER NOT NULL,
        payload TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot,id));
      CREATE TABLE IF NOT EXISTS outbox(bot TEXT, id TEXT, topic INTEGER NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot,id));`);
      const columns = this.db.prepare('PRAGMA table_info(inbox)').all();
      if (!columns.some((column) => column.name === 'firstSeen')) this.addInboxColumns();
      this.db.exec(`CREATE INDEX IF NOT EXISTS inbox_open ON inbox(bot,lane,topic,id) WHERE done=0; PRAGMA user_version=${telegramInboxVersion}`);
    });
  }

  private addInboxColumns() {
    this.db.exec(`ALTER TABLE inbox ADD COLUMN firstSeen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbox ADD COLUMN started INTEGER;
      ALTER TABLE inbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbox ADD COLUMN due INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbox ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbox ADD COLUMN lane TEXT NOT NULL DEFAULT 'work';`);
    const save = this.db.prepare('UPDATE inbox SET firstSeen=?,lane=? WHERE bot=? AND id=?');
    const now = Date.now();
    for (const row of this.db.prepare('SELECT bot,id,payload FROM inbox WHERE done=0').all()) {
      const { text } = JSON.parse(String(row.payload));
      save.run(now, laneOf(row.bot as Bot, text), row.bot, row.id);
    }

  }

  transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { work(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  offset(bot: Bot) {
    return Number(this.db.prepare('SELECT next FROM cursor WHERE bot=?').get(bot)?.next ?? 0);
  }

  admit(bot: Bot, owner: string, updates: Update[], now = Date.now()) {
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
            this.db.prepare('INSERT OR IGNORE INTO inbox(bot,id,topic,payload,firstSeen,lane) VALUES (?,?,?,?,?,?)')
              .run(bot, update.update_id, topic, JSON.stringify({ text, document, photo }), now, laneOf(bot, text));
          }
        }
        next = Math.max(next, update.update_id + 1);
      }
      this.db.prepare('INSERT INTO cursor VALUES (?,?) ON CONFLICT(bot) DO UPDATE SET next=excluded.next').run(bot, next);
    });
  }

  next(bot: Bot, lane: Lane, now: number) {
    return this.db.prepare(`SELECT bot,id,topic,payload,started,attempts FROM inbox AS item
      WHERE bot=? AND lane=? AND done=0 AND due<=? AND NOT EXISTS (
        SELECT 1 FROM inbox prior WHERE prior.bot=item.bot AND prior.lane=item.lane
          AND prior.topic=item.topic AND prior.done=0 AND prior.id<item.id)
      ORDER BY id LIMIT 1`).get(bot, lane, now) as (Intake & { started: number | null; attempts: number }) | undefined;
  }

  attempt(row: Intake, now: number, due: number) {
    this.db.prepare('UPDATE inbox SET attempts=attempts+1,started=COALESCE(started,?),due=? WHERE bot=? AND id=? AND done=0')
      .run(now, due, row.bot, row.id);
  }

  notify(bot: Bot, id: string, topic: number, text: string) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(bot,id,topic,text) VALUES (?,?,?,?)').run(bot, id, topic, text);
  }

  notifyReviews(intents: readonly { review?: unknown }[]) {
    for (const { review } of intents) {
      this.notify('bi', 'review-' + review, 0, 'BI 審核已發布。請在工作台查看版本。');
    }
  }

  resend(bot: unknown, id: unknown) {
    if ((bot !== 'main' && bot !== 'bi') || typeof id !== 'string' || !this.db.prepare(
      "UPDATE outbox SET state='pending',due=0 WHERE bot=? AND id=? AND state='indeterminate'",
    ).run(bot, id).changes) throw new Error('Delivery is unavailable for resend');
  }

  complete(row: Intake, text: string, failed = false) {
    this.transaction(() => {
      this.notify(row.bot, 'update-' + row.id, row.topic, text);
      this.db.prepare('UPDATE inbox SET done=1,failed=? WHERE bot=? AND id=? AND done=0').run(Number(failed), row.bot, row.id);
    });
  }
}
