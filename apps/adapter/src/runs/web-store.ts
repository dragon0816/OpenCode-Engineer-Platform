import type { FileIdentity, RunRecord } from '../../../../packages/contracts/src/run.ts';
import type { Agent } from '../opencode/sessions.ts';
import { Ledger } from './ledger.ts';

export const projects = [
  { id: 'default', title: '主要工作區' },
  { id: 'secondary', title: '獨立工作區' },
] as const;
export type ProjectID = typeof projects[number]['id'];

export type WebSession = { project: ProjectID; id: string; upstreamID: string; agent: Agent; alias: string; createdAt: number; title?: string | null };
export type Attachment = { id: string; name: string; mime: string; original: FileIdentity; projection?: FileIdentity };

export class WebStore extends Ledger {
  constructor(file: string) {
    super(file, true);
    this.db.exec(`CREATE TABLE IF NOT EXISTS web_session_display (
      id TEXT PRIMARY KEY REFERENCES web_sessions(id),
      title TEXT,
      removed INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_session_project (
      id TEXT PRIMARY KEY REFERENCES web_sessions(id),
      project TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_preferences (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      name TEXT NOT NULL,
      introduction TEXT NOT NULL,
      instructions TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_settings_audit (
      id INTEGER PRIMARY KEY,
      section TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_model_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      alias TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_appearance (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      theme TEXT NOT NULL,
      density TEXT NOT NULL,
      avatar BLOB,
      mime TEXT
    ) STRICT`);
  }

  preferences() {
    return this.db.prepare('SELECT name, introduction, instructions FROM web_preferences WHERE id = 1')
      .get() as { name: string; introduction: string; instructions: string } | undefined;
  }

  savePreferences(name: string, introduction: string, instructions: string) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO web_preferences VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, introduction = excluded.introduction, instructions = excluded.instructions`)
        .run(name, introduction, instructions);
      this.auditSettings('assistant');
    });
  }

  private auditSettings(section: string) {
    this.db.prepare('INSERT INTO web_settings_audit (section, changed_at) VALUES (?, ?)').run(section, Date.now());
  }

  appearance() {
    return this.db.prepare('SELECT theme, density, avatar, mime FROM web_appearance WHERE id = 1').get() as
      { theme: string; density: string; avatar: Uint8Array | null; mime: string | null } | undefined;
  }

  saveAppearance(theme: string, density: string, image?: { bytes: Buffer; mime: string } | null) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO web_appearance (id, theme, density) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET theme = excluded.theme, density = excluded.density`).run(theme, density);
      if (image !== undefined) {
        this.db.prepare('UPDATE web_appearance SET avatar = ?, mime = ? WHERE id = 1')
          .run(image?.bytes ?? null, image?.mime ?? null);
      }
      this.auditSettings('appearance');
    });
  }

  defaultAlias() {
    return this.db.prepare('SELECT alias FROM web_model_settings WHERE id = 1').get()?.alias as string | undefined;
  }

  saveDefaultAlias(alias: string) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO web_model_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET alias = excluded.alias').run(alias);
      this.auditSettings('model');
    });
  }

  saveSessionAlias(id: string, alias: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE web_sessions SET alias = ? WHERE id = ?').run(alias, id);
      this.auditSettings('session-model');
    });
  }

  renameSession(id: string, title: string) {
    this.db.prepare(`INSERT INTO web_session_display (id, title) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title`).run(id, title);
  }

  hideSession(id: string) {
    this.db.prepare(`INSERT INTO web_session_display (id, removed) VALUES (?, 1)
      ON CONFLICT(id) DO UPDATE SET removed = 1`).run(id);
  }

  createSession(session: Omit<WebSession, 'project'> & Partial<Pick<WebSession, 'project'>>) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO web_sessions VALUES (?, ?, ?, ?, ?)')
        .run(session.id, session.upstreamID, session.agent, session.alias, session.createdAt);
      this.db.prepare('INSERT INTO web_session_project VALUES (?, ?)').run(session.id, session.project ?? 'default');
    });
  }

  sessions() {
    return this.db.prepare(`SELECT s.id, upstream_id AS upstreamID, agent, alias, created_at AS createdAt, d.title,
      COALESCE(p.project, 'default') AS project
      FROM web_sessions s LEFT JOIN web_session_display d ON d.id = s.id
      LEFT JOIN web_session_project p ON p.id = s.id
      WHERE COALESCE(d.removed, 0) = 0 ORDER BY created_at, s.id`)
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

  deleteAttachment(sessionID: string, id: string) {
    return this.db.prepare('DELETE FROM attachments WHERE session_id = ? AND id = ?').run(sessionID, id).changes;
  }

  turn(sessionID: string, id: string) {
    const row = this.db.prepare('SELECT request_hash AS hash FROM web_turns WHERE session_id = ? AND run_id = ?')
      .get(sessionID, id);
    return row ? { hash: String(row.hash), run: this.get(id) } : undefined;
  }

  hasTurn(id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM web_turns WHERE run_id = ?').get(id));
  }

  saveTurn(sessionID: string, run: RunRecord, hash: string) {
    this.transaction(() => {
      this.insert(run);
      this.db.prepare('INSERT INTO web_turns VALUES (?, ?, ?)').run(sessionID, run.id, hash);
    });
  }

  turns(sessionID: string) {
    return this.db.prepare(
      'SELECT r.record FROM web_turns t JOIN runs r ON r.id = t.run_id WHERE t.session_id = ? ORDER BY t.rowid',
    ).all(sessionID).map((row) => JSON.parse(String(row.record)) as RunRecord);
  }
}
