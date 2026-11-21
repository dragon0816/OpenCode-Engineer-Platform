import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';
import type { RunRecord, RunState } from '../../../../packages/contracts/src/run.ts';

const transitions: Record<RunState, RunState[]> = {
  accepted: ['running', 'failed', 'indeterminate'],
  running: ['running', 'awaiting_permission', 'background', 'failed', 'indeterminate', 'verified'],
  awaiting_permission: ['running', 'failed', 'indeterminate'],
  background: ['running', 'failed', 'indeterminate', 'verified'],
  indeterminate: ['running', 'failed'],
  failed: [],
  verified: [],
};

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) this.transaction(() => {
      this.db.exec(readFileSync(atRepo('apps/adapter/migrations/001_runs.sql'), 'utf8'));
      this.db.exec('PRAGMA user_version = 1');
    });
    else if (version !== 1) throw new Error('Unsupported run ledger version');
  }

  private transaction<T>(work: () => T) {
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
    if (run.state !== 'accepted') throw new Error('A new run must be accepted');
    this.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES(?, ?, ?)').run(run.id, run.state, JSON.stringify(run));
      this.append(run);
    });
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
