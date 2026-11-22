import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';
import { parseAvatar } from '../http/avatar.ts';
import type { CustomMcp } from './custom-mcp.ts';

export const legacyProjects = [
  { id: 'default', title: '主要工作區' },
  { id: 'secondary', title: '獨立工作區' },
] as const;
const biWorkspace = ['agents', 'bi'] as const;
const channelAccount = 'telegram-main';

export function legacyWorkspace(project: unknown) {
  if (project === 'default') return 'legacy-default';
  if (project === 'secondary') return 'legacy-secondary';
  throw new Error('Unknown legacy project');
}

export function prepareBiWorkspace(webRoot: string) {
  const root = resolve(webRoot);
  const ensure = (parent: string, name: string) => {
    const path = join(parent, name);
    mkdirSync(path, { recursive: true });
    if (!lstatSync(path).isDirectory()) throw new Error('Unsafe BI workspace path');
    return path;
  };
  // Check the fixed parents before creating any descendants.
  if (!lstatSync(dirname(root)).isDirectory()) throw new Error('Unsafe BI workspace root');
  mkdirSync(root, { recursive: true });
  if (!lstatSync(root).isDirectory()) throw new Error('Unsafe BI workspace root');
  const workspace = biWorkspace.reduce(ensure, root);
  for (const name of ['sessions', 'model-work', 'artifacts']) ensure(workspace, name);
}

export function hasTable(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

function openSibling(directory: string, name: string) {
  const path = join(directory, name);
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return;
  if (!file.isFile() || file.nlink !== 1) throw new Error('Unsafe agent ledger source');
  return new DatabaseSync(path, { readOnly: true });
}

function legacyTopics(directory: string) {
  using db = openSibling(directory, 'telegram.sqlite');
  const topics = new Map<string, number>();
  if (db && hasTable(db, 'telegram_sessions')) {
    for (const { session, topic } of db.prepare('SELECT session, topic FROM telegram_sessions').iterate()) {
      if (typeof session !== 'string' || typeof topic !== 'number' || topics.has(session)) {
        throw new Error('Invalid legacy Telegram session mapping');
      }
      topics.set(session, topic);
    }
  }
  return topics;
}

function legacyVaultGrants(directory: string) {
  using knowledge = openSibling(directory, 'knowledge.sqlite');
  if (!knowledge || !hasTable(knowledge, 'vaults')) return { vaults: [] };
  const inactive = hasTable(knowledge, 'inactive_vaults') ?
    'WHERE NOT EXISTS (SELECT 1 FROM inactive_vaults i WHERE i.vault = v.id)' : '';
  const vaults = knowledge.prepare(`SELECT v.id, p.kind FROM vaults v
    JOIN publications p ON p.id = v.publication AND p.vault = v.id ${inactive} ORDER BY v.id`).all();
  using telegram = openSibling(directory, 'telegram.sqlite');
  const target = telegram && hasTable(telegram, 'bi_config') ?
    telegram.prepare("SELECT value FROM bi_config WHERE name='target'").get()?.value : undefined;
  return { vaults, target: vaults.find(({ id, kind }) => id === target && kind === 'bi')?.id };
}

type SeedRows = Record<string, SQLInputValue[][]>;

function ownedSession(id: string, project: unknown, channel: boolean, topic?: number): SQLInputValue[] {
  return [id, 'main', legacyWorkspace(project), channel ? 'channel' : 'web', channel ? channelAccount : null,
    channel ? topic === undefined ? 'legacy-session:' + id : 'topic:' + topic : null, channel ? 1 : null];
}

export function insertLegacySessionOwner(db: DatabaseSync, session: string, project: unknown, channel: boolean, topic?: number) {
  db.prepare('INSERT INTO session_ownership VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(...ownedSession(session, project, channel, topic));
}

function mcpGrants(server: string, projects: readonly string[]) {
  return projects.map((project) => [legacyWorkspace(project), server]);
}

export function replaceLegacyMcpGrants(db: DatabaseSync, definition: Pick<CustomMcp, 'id' | 'enabled' | 'appliesToProjects'>) {
  db.prepare(`INSERT INTO agent_capabilities VALUES ('main', 'mcp', ?, ?)
    ON CONFLICT(agent_id, kind, capability_id) DO UPDATE SET enabled=excluded.enabled`)
    .run(definition.id, Number(definition.enabled));
  db.prepare('DELETE FROM workspace_mcp_grants WHERE server_id = ?').run(definition.id);
  const insert = db.prepare('INSERT INTO workspace_mcp_grants VALUES (?, ?)');
  for (const grant of mcpGrants(definition.id, definition.appliesToProjects)) insert.run(...grant);
}

export function legacyAgentRows(db: DatabaseSync | undefined, directory: string, channel: boolean): SeedRows {
  const topics = channel ? legacyTopics(directory) : new Map<string, number>();
  const sessionRows = !db || !hasTable(db, 'web_sessions') ? [] :
    db.prepare(hasTable(db, 'web_session_project') ?
      `SELECT s.id, COALESCE(p.project, 'default') AS project FROM web_sessions s
        LEFT JOIN web_session_project p ON p.id = s.id` :
      "SELECT id, 'default' AS project FROM web_sessions").all().map(({ id, project }) =>
      ownedSession(String(id), project, channel, topics.get(String(id))));
  if (channel) return { session_ownership: sessionRows };

  const preferences = db && hasTable(db, 'web_preferences') ?
    db.prepare('SELECT name, introduction, instructions FROM web_preferences WHERE id=1').get() : undefined;
  const appearance = db && hasTable(db, 'web_appearance') ?
    db.prepare('SELECT avatar, mime FROM web_appearance WHERE id=1').get() : undefined;
  if (appearance && (appearance.avatar !== null || appearance.mime !== null)) {
    const image = appearance.avatar instanceof Uint8Array && parseAvatar(Buffer.from(appearance.avatar).toString('base64'));
    if (!image || image.mime !== appearance.mime) throw new Error('Invalid legacy assistant avatar');
  }
  const folders = db && hasTable(db, 'web_project_folders') ?
    db.prepare('SELECT project, folder FROM web_project_folders').all() : [];
  const servers = db && hasTable(db, 'mcp_servers') ?
    db.prepare('SELECT id, definition FROM mcp_servers').all().map(({ id, definition }) => ({
      ...JSON.parse(String(definition)) as CustomMcp, id: String(id),
    })) : [];
  const { vaults, target } = legacyVaultGrants(directory);
  return {
    agents: [
      ['main', 'orchestrator', 'main', 'active', preferences?.name ?? '', preferences?.introduction ?? '',
        preferences?.instructions ?? '', appearance?.avatar ?? null, appearance?.mime ?? null, null, 'zh-TW', 1, 0, 0],
      ['bi', 'specialist', 'bi', 'active', 'BI 資料處理', '接收使用者傳來的資料，處理成 BI 卡片並送審', '',
        null, null, null, 'zh-TW', 1, 0, 0],
    ],
    agent_workspaces: [
      ['legacy-default', 'main', 'legacy_default', 'web', legacyProjects[0].title, 1, 'unclassified', 0],
      ['legacy-secondary', 'main', 'legacy_secondary', 'web/secondary', legacyProjects[1].title, 0, 'unclassified', 0],
      ['bi', 'bi', 'managed', ['web', ...biWorkspace].join('/'), null, 1, 'unclassified', 0],
    ],
    workspace_read_folders: folders.map(({ project, folder }) => [legacyWorkspace(project), folder]),
    agent_knowledge_reads: [...vaults.map(({ id }) => ['main', id]), ...(target ? [['bi', target]] : [])],
    agent_write_targets: target ? [['bi', 'knowledge', target, 'proposal_only']] : [],
    agent_capabilities: servers.map(({ id, enabled }) => ['main', 'mcp', id, Number(enabled)]),
    workspace_mcp_grants: servers.flatMap(({ id, appliesToProjects }) => mcpGrants(id, appliesToProjects)),
    agent_trigger_settings: [['main', 1], ['bi', 1]],
    session_ownership: sessionRows,
    delegation_budget_settings: [[1, 3, 300_000, 10, 30, 30, 90, 600_000]],
  };
}

export function migrateAgentLedger(db: DatabaseSync, file: string, channel: boolean) {
  if (!channel) db.exec(readFileSync(atRepo('apps/adapter/migrations/003_agent_ledger.sql'), 'utf8'));
  db.exec(`CREATE TABLE session_ownership (
    session_id TEXT PRIMARY KEY REFERENCES web_sessions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    agent_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('web', 'channel', 'delegation', 'schedule')),
    channel_account_id TEXT,
    conversation_key TEXT,
    binding_revision INTEGER,
    CHECK((origin = 'channel' AND channel_account_id IS NOT NULL AND conversation_key IS NOT NULL AND binding_revision IS NOT NULL) OR
      (origin <> 'channel' AND channel_account_id IS NULL AND conversation_key IS NULL AND binding_revision IS NULL))
    ${channel ? '' : ', FOREIGN KEY(workspace_id, agent_id) REFERENCES agent_workspaces(id, agent_id) ON DELETE RESTRICT ON UPDATE RESTRICT'}
  ) STRICT;
  CREATE INDEX session_ownership_by_agent_origin ON session_ownership(agent_id, origin, session_id);`);
  if (!channel) db.exec(`CREATE TRIGGER agents_archive_without_open_runs BEFORE UPDATE OF state ON agents
    WHEN OLD.state = 'active' AND NEW.state = 'archived' AND OLD.builtin_key IS NULL AND EXISTS (
      SELECT 1 FROM session_ownership o JOIN web_turns t ON t.session_id = o.session_id
      JOIN runs r ON r.id = t.run_id WHERE o.agent_id = OLD.id AND r.state NOT IN ('verified', 'failed', 'cancelled')
    ) BEGIN
      SELECT RAISE(ABORT, 'An agent with open runs cannot be archived');
    END;`);
  for (const [table, rows] of Object.entries(legacyAgentRows(db, dirname(file), channel))) {
    if (!rows.length) continue;
    const insert = db.prepare(`INSERT INTO ${table} VALUES (${rows[0].map(() => '?').join(', ')})`);
    for (const row of rows) insert.run(...row);
  }
}

export function verifyTelegramSessionOwners(db: DatabaseSync, central?: DatabaseSync) {
  const find = central?.prepare('SELECT 1 FROM agent_workspaces WHERE id = ? AND agent_id = ?');
  for (const { workspace_id, agent_id } of db.prepare('SELECT DISTINCT workspace_id, agent_id FROM session_ownership').iterate()) {
    if (!find?.get(workspace_id, agent_id)) throw new Error('Telegram session workspace ownership is invalid');
  }
}

export function verifyAgentLedger(db: DatabaseSync, file: string, channel: boolean) {
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Agent ledger foreign keys are invalid');
  if (db.prepare(`SELECT 1 FROM web_sessions s LEFT JOIN session_ownership o ON o.session_id = s.id
    WHERE o.session_id IS NULL LIMIT 1`).get()) throw new Error('Session ownership is missing');
  if (channel) {
    using central = openSibling(dirname(file), 'web.sqlite');
    verifyTelegramSessionOwners(db, central);
    return;
  }
  if (db.prepare(`SELECT count(*) AS total FROM agents
    WHERE role='orchestrator' OR id='bi'`).get()?.total !== 2 ||
      !db.prepare(`SELECT 1 FROM agents WHERE id='main' AND builtin_key='main' AND role='orchestrator' AND state='active'`).get() ||
      !db.prepare(`SELECT 1 FROM agents WHERE id='bi' AND builtin_key='bi' AND role='specialist' AND state='active'`).get()) {
    throw new Error('Built-in agents are missing');
  }
  const grants = db.prepare(`SELECT vault_id FROM agent_knowledge_reads
    UNION SELECT target_id FROM agent_write_targets WHERE target_kind='knowledge'`).all();
  if (grants.length) {
    using knowledge = openSibling(dirname(file), 'knowledge.sqlite');
    const find = knowledge?.prepare(`SELECT 1 FROM vaults v JOIN publications p ON p.id=v.publication AND p.vault=v.id WHERE v.id=?`);
    if (grants.some(({ vault_id }) => !find?.get(vault_id))) throw new Error('Agent knowledge vault reference is invalid');
  }
}
