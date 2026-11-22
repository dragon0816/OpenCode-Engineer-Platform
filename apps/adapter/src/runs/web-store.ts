import type { FileIdentity, RunRecord } from '../../../../packages/contracts/src/run.ts';
import type { Agent } from '../opencode/sessions.ts';
import { maxSelectedModels } from '../opencode/gateway.ts';
import { parseTurnLimits, turnLimitDefaults } from '../opencode/turn-limits.ts';
import type { TurnLimits } from '../opencode/turn-limits.ts';
import { Ledger } from './ledger.ts';
import { validateCustomStdioMcp } from './custom-mcp.ts';
import type { CustomMcp } from './custom-mcp.ts';

export const projects = [
  { id: 'default', title: '主要工作區' },
  { id: 'secondary', title: '獨立工作區' },
] as const;
export type ProjectID = typeof projects[number]['id'];

export type WebSession = { project: ProjectID; id: string; upstreamID: string; agent: Agent; alias: string; createdAt: number; title?: string | null; knowledgeDisabled?: number };
export type Attachment = { id: string; name: string; mime: string; original: FileIdentity; projection?: FileIdentity };
type ModelCatalog = { ids: string[]; discoveredAt: number };

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
    CREATE TABLE IF NOT EXISTS web_turn_limits (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      settings TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_model_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      alias TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_model_catalog (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      ids TEXT NOT NULL,
      discovered_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_model_selection (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      ids TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_project_folders (
      project TEXT NOT NULL,
      folder TEXT NOT NULL,
      PRIMARY KEY(project, folder)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_action_decisions (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES web_sessions(id),
      action TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_message_annotations (
      session_id TEXT NOT NULL REFERENCES web_sessions(id),
      message_id TEXT NOT NULL,
      note TEXT,
      rating TEXT,
      reason TEXT,
      PRIMARY KEY(session_id, message_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_turn_replies (
      run_id TEXT PRIMARY KEY REFERENCES runs(id),
      message_id TEXT NOT NULL,
      text TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_session_knowledge_disabled (
      id TEXT PRIMARY KEY REFERENCES web_sessions(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_knowledge_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      atlas_url TEXT NOT NULL,
      toolbox INTEGER NOT NULL CHECK(toolbox IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY NOT NULL,
      definition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_appearance (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      theme TEXT NOT NULL,
      density TEXT NOT NULL,
      avatar BLOB,
      mime TEXT
    ) STRICT`);
  }

  customMcpServers() {
    return this.db.prepare('SELECT definition, created_at, updated_at FROM mcp_servers ORDER BY created_at, id').all()
      .map((row) => {
        const definition = JSON.parse(String(row.definition)) as CustomMcp;
        return { ...definition, deniedTools: definition.deniedTools ?? [],
          createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
      });
  }

  saveCustomStdioMcp(id: string, input: Record<string, unknown>) {
    const definition = validateCustomStdioMcp(id, input, projects.map((project) => project.id));
    return this.saveCustomMcp(definition);
  }

  saveCustomMcp<T extends CustomMcp>(definition: T) {
    const { id } = definition;
    const existing = this.db.prepare('SELECT created_at, updated_at FROM mcp_servers WHERE id = ?').get(id);
    const now = Math.max(Date.now(), Number(existing?.updated_at ?? 0) + 1);
    const createdAt = Number(existing?.created_at ?? now);
    const { changes } = this.db.prepare(`
      INSERT INTO mcp_servers (id, definition, created_at, updated_at)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM mcp_servers WHERE id = ?) OR (SELECT count(*) FROM mcp_servers) < 20
      ON CONFLICT(id) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(definition), createdAt, now, id);
    if (!changes) throw new Error('最多可設定 20 個自訂 MCP 伺服器。');
    return { ...definition, createdAt, updatedAt: now };
  }

  removeCustomMcp(id: string) {
    return Boolean(this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes);
  }

  knowledgeSettings() {
    const row = this.db.prepare('SELECT atlas_url AS atlasUrl, toolbox FROM web_knowledge_settings WHERE id=1').get();
    return { atlasUrl: String(row?.atlasUrl ?? ''), toolbox: row?.toolbox !== 0 };
  }

  saveKnowledgeSettings(atlasUrl: string, toolbox: boolean) {
    this.db.prepare('INSERT OR REPLACE INTO web_knowledge_settings VALUES (1, ?, ?)').run(atlasUrl, Number(toolbox));
  }

  projectFolders() {
    return this.db.prepare('SELECT project, folder FROM web_project_folders ORDER BY folder')
      .all() as { project: ProjectID; folder: string }[];
  }

  addProjectFolder(project: ProjectID, folder: string) {
    this.db.prepare('INSERT INTO web_project_folders VALUES (?, ?)').run(project, folder);
  }

  removeProjectFolder(project: ProjectID, folder: string) {
    return this.db.prepare('DELETE FROM web_project_folders WHERE project = ? AND folder = ?').run(project, folder).changes > 0;
  }

  actionDecisions(sessionID: string) {
    return this.db.prepare('SELECT action, decision, created_at AS createdAt FROM web_action_decisions WHERE session_id = ? ORDER BY id')
      .all(sessionID);
  }

  decideSessionRemoval(sessionID: string, decision: 'accept' | 'reject') {
    this.transaction(() => {
      this.db.prepare("INSERT INTO web_action_decisions (session_id, action, decision, created_at) VALUES (?, 'remove-session', ?, ?)")
        .run(sessionID, decision, Date.now());
      if (decision === 'accept') this.hideSession(sessionID);
    });
  }

  annotations(sessionID: string) {
    return this.db.prepare('SELECT message_id AS messageID, note, rating, reason FROM web_message_annotations WHERE session_id = ?')
      .all(sessionID);
  }

  annotate(sessionID: string, messageID: string, field: 'note' | 'rating', value: string | null, reason: string | null) {
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO web_message_annotations (session_id, message_id) VALUES (?, ?)').run(sessionID, messageID);
      if (field === 'note') this.db.prepare('UPDATE web_message_annotations SET note = ? WHERE session_id = ? AND message_id = ?')
        .run(value, sessionID, messageID);
      else this.db.prepare('UPDATE web_message_annotations SET rating = ?, reason = ? WHERE session_id = ? AND message_id = ?')
        .run(value, reason, sessionID, messageID);
      this.db.prepare('DELETE FROM web_message_annotations WHERE session_id = ? AND message_id = ? AND note IS NULL AND rating IS NULL')
        .run(sessionID, messageID);
    });
  }

  reply(runID: string) {
    return this.db.prepare('SELECT message_id AS id, text FROM web_turn_replies WHERE run_id = ?').get(runID) as
      { id: string; text: string } | undefined;
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

  turnLimits() {
    const row = this.db.prepare('SELECT settings FROM web_turn_limits WHERE id = 1').get();
    return (row && parseTurnLimits(JSON.parse(String(row.settings)))) ?? turnLimitDefaults;
  }

  saveTurnLimits(limits: TurnLimits) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO web_turn_limits VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings')
        .run(JSON.stringify(limits));
      this.auditSettings('turn-limits');
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

  modelCatalog(): ModelCatalog | undefined {
    const row = this.db.prepare('SELECT ids, discovered_at FROM web_model_catalog WHERE id = 1').get();
    if (row) return { ids: JSON.parse(String(row.ids)) as string[], discoveredAt: Number(row.discovered_at) };
  }

  modelChoices(builtIns: readonly string[]) {
    return [...new Set([...(this.modelCatalog()?.ids ?? []), ...builtIns])];
  }

  modelSelection(builtIns: readonly string[], fallback = builtIns[0]) {
    const row = this.db.prepare('SELECT ids FROM web_model_selection WHERE id = 1').get();
    const ids = row ? JSON.parse(String(row.ids)) as string[] : [...builtIns];
    const saved = this.defaultAlias();
    return { ids, defaultAlias: saved && ids.includes(saved) ? saved : ids.includes(fallback) ? fallback : ids[0] };
  }

  saveModelSelection(ids: unknown, alias: unknown, builtIns: readonly string[]) {
    const choices = this.modelChoices(builtIns);
    if (!Array.isArray(ids) || !ids.length || ids.length > maxSelectedModels || new Set(ids).size !== ids.length ||
        !ids.every((id) => typeof id === 'string' && choices.includes(id)) || typeof alias !== 'string' || !ids.includes(alias)) return false;
    this.transaction(() => this.writeModelSelection(ids, alias));
    return true;
  }

  saveModelCatalog(catalog: ModelCatalog, builtIns: readonly string[]) {
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO web_model_catalog VALUES (1, ?, ?)').run(JSON.stringify(catalog.ids), catalog.discoveredAt);
      const selection = this.modelSelection(builtIns);
      const choices = new Set([...catalog.ids, ...builtIns]);
      const remaining = selection.ids.filter((id) => choices.has(id));
      if (remaining.length === selection.ids.length) return;
      if (!remaining.length) remaining.push(builtIns[0]);
      const alias = remaining.includes(selection.defaultAlias) ? selection.defaultAlias : remaining[0];
      this.writeModelSelection(remaining, alias);
    });
  }

  private writeModelSelection(ids: string[], alias: string) {
    this.db.prepare('INSERT OR REPLACE INTO web_model_selection VALUES (1, ?)').run(JSON.stringify(ids));
    this.db.prepare('INSERT OR REPLACE INTO web_model_settings VALUES (1, ?)').run(alias);
    this.auditSettings('model');
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
      if (session.knowledgeDisabled) this.db.prepare('INSERT INTO web_session_knowledge_disabled VALUES (?)').run(session.id);
      this.db.prepare('INSERT INTO web_session_project VALUES (?, ?)').run(session.id, session.project ?? 'default');
    });
  }

  sessions() {
    return this.db.prepare(`SELECT s.id, upstream_id AS upstreamID, agent, alias, created_at AS createdAt, d.title,
      COALESCE(p.project, 'default') AS project, k.id IS NOT NULL AS knowledgeDisabled
      FROM web_sessions s LEFT JOIN web_session_display d ON d.id = s.id
      LEFT JOIN web_session_project p ON p.id = s.id
      LEFT JOIN web_session_knowledge_disabled k ON k.id = s.id
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

  saveTurn(sessionID: string, run: RunRecord, hash: string, reply?: { id: string; text: string }) {
    this.transaction(() => {
      this.insert(run);
      this.db.prepare('INSERT INTO web_turns VALUES (?, ?, ?)').run(sessionID, run.id, hash);
      if (reply) this.db.prepare('INSERT INTO web_turn_replies VALUES (?, ?, ?)').run(run.id, reply.id, reply.text);
    });
  }

  turns(sessionID: string) {
    return this.db.prepare(
      'SELECT r.record FROM web_turns t JOIN runs r ON r.id = t.run_id WHERE t.session_id = ? ORDER BY t.rowid',
    ).all(sessionID).map((row) => JSON.parse(String(row.record)) as RunRecord);
  }
}
