import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';
import type { RunRecord, RunState } from '../../../../packages/contracts/src/run.ts';

const transitions: Record<RunState, RunState[]> = {
  accepted: ['running', 'failed', 'cancelled', 'indeterminate'],
  running: ['running', 'awaiting_permission', 'background', 'failed', 'cancelled', 'indeterminate', 'verified'],
  awaiting_permission: ['running', 'failed', 'cancelled', 'indeterminate'],
  background: ['running', 'failed', 'cancelled', 'indeterminate', 'verified'],
  indeterminate: ['running', 'failed'],
  cancelled: [],
  failed: [],
  verified: [],
};

export const runLedgerVersion = 1;
export const telegramChatLedgerVersion = 3;
export const webLedgerVersion = 4;
type WebMigration = { version: number; migrate: (db: DatabaseSync, version: number) => void; verify: (db: DatabaseSync) => void };

export class Ledger {
  protected readonly db: DatabaseSync;

  constructor(file: string, web?: WebMigration) {
    this.db = new DatabaseSync(file);
    try {
      this.migrate(file, web);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(file: string, web?: WebMigration) {
    const expectedVersion = web?.version ?? runLedgerVersion;
    const current = () => {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > expectedVersion) throw new Error('執行紀錄資料庫版本比程式新。請使用新版程式或先回退資料。');
      if (version < 0) throw new Error('執行紀錄資料庫版本無效。');
      return version;
    };
    const version = current();
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;');
    if (version === expectedVersion) {
      web?.verify(this.db);
      return;
    }
    if (web && version === 1) this.db.prepare('VACUUM INTO ?').run(`${file}.before-v2-${Date.now()}`);
    this.transaction(() => {
      const version = current();
      if (version === 0) {
        this.db.exec(readFileSync(atRepo('apps/adapter/migrations/001_runs.sql'), 'utf8'));
        this.db.exec(`PRAGMA user_version = ${runLedgerVersion}`);
      }
      if (web && version < 2) {
        this.db.exec(readFileSync(atRepo('apps/adapter/migrations/002_attachments.sql'), 'utf8'));
      }
      if (web && version < expectedVersion) {
        web.migrate(this.db, version);
        web.verify(this.db);
        this.db.exec(`PRAGMA user_version = ${expectedVersion}`);
      }
    });
  }

  protected transaction<T>(work: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private append(run: RunRecord) {
    this.db.prepare('INSERT INTO run_events(run_id, at, state, record) VALUES(?, ?, ?, ?)')
      .run(run.id, Date.now(), run.state, JSON.stringify(run));
  }

  create(run: RunRecord) {
    return this.transaction(() => this.insert(run));
  }

  protected insert(run: RunRecord) {
    if (run.state !== 'accepted') throw new Error('A new run must be accepted');
    this.db.prepare('INSERT INTO runs VALUES(?, ?, ?)').run(run.id, run.state, JSON.stringify(run));
    this.append(run);
    return run;
  }

  get(id: string) {
    const result = this.db.prepare('SELECT record FROM runs WHERE id = ?').get(id);
    if (!result) throw new Error('Unknown run');
    return JSON.parse(String(result.record)) as RunRecord;
  }

  change(id: string, state: RunState, patch: Partial<Omit<RunRecord, 'id' | 'state'>> = {}) {
    return this.transaction(() => {
      const previous = this.get(id);
      if (!transitions[previous.state].includes(state)) throw new Error('Invalid run state transition');
      const updated: RunRecord = { ...previous, ...patch, state };
      this.db.prepare('UPDATE runs SET state = ?, record = ? WHERE id = ?').run(state, JSON.stringify(updated), id);
      this.append(updated);
      return updated;
    });
  }

  history(id: string) {
    return this.db.prepare('SELECT record FROM run_events WHERE run_id = ? ORDER BY sequence').all(id)
      .map((row) => JSON.parse(String(row.record)) as RunRecord);
  }

  close() { this.db.close(); }
}
