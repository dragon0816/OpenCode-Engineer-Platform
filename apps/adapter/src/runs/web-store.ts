import type { FileIdentity, RunRecord } from '../../../../packages/contracts/src/run.ts';
import type { Agent } from '../opencode/sessions.ts';
import { Ledger } from './ledger.ts';

export type WebSession = { id: string; upstreamID: string; agent: Agent; alias: string; createdAt: number };
export type Attachment = { id: string; name: string; mime: string; original: FileIdentity; projection?: FileIdentity };

export class WebStore extends Ledger {
  constructor(file: string) { super(file, true); }

  createSession(session: WebSession) {
    this.db.prepare('INSERT INTO web_sessions VALUES (?, ?, ?, ?, ?)')
      .run(session.id, session.upstreamID, session.agent, session.alias, session.createdAt);
  }

  sessions() {
    return this.db.prepare('SELECT id, upstream_id AS upstreamID, agent, alias, created_at AS createdAt FROM web_sessions ORDER BY created_at, id')
      .all() as WebSession[];
  }

  attachment(sessionID: string, id: string) {
    const row = this.db.prepare('SELECT record FROM attachments WHERE session_id = ? AND id = ?').get(sessionID, id);
    return row ? JSON.parse(String(row.record)) as Attachment : undefined;
  }

  attachments(sessionID: string) {
    return this.db.prepare('SELECT record FROM attachments WHERE session_id = ? ORDER BY rowid').all(sessionID)
      .map((row) => JSON.parse(String(row.record)) as Attachment);
  }

  attachmentBytes(sessionID: string) {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM attachments WHERE session_id = ?').get(sessionID);
    return Number(row?.bytes);
  }

  saveAttachment(sessionID: string, record: Attachment) {
    const bytes = record.original.bytes + (record.projection?.bytes ?? 0);
    this.db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?)').run(record.id, sessionID, bytes, JSON.stringify(record));
  }

  turn(sessionID: string, id: string) {
    const row = this.db.prepare('SELECT request_hash AS hash, workbook FROM web_turns WHERE session_id = ? AND run_id = ?')
      .get(sessionID, id);
    return row ? { hash: String(row.hash), run: this.get(id) } : undefined;
  }

  hasTurn(id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM web_turns WHERE run_id = ?').get(id));
  }

  saveTurn(sessionID: string, run: RunRecord, hash: string, workbook: boolean) {
    this.transaction(() => {
      this.insert(run);
      this.db.prepare('INSERT INTO web_turns VALUES (?, ?, ?, ?)').run(sessionID, run.id, hash, Number(workbook));
    });
  }

  turns(sessionID: string) {
    return this.db.prepare(
      'SELECT r.record FROM web_turns t JOIN runs r ON r.id = t.run_id WHERE t.session_id = ? ORDER BY t.rowid',
    ).all(sessionID).map((row) => JSON.parse(String(row.record)) as RunRecord);
  }
}
