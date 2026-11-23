import { basename } from 'node:path';
import type { FileIdentity, RunRecord } from '../../../../packages/contracts/src/run.ts';
import type { Agent } from '../opencode/sessions.ts';
import { maxSelectedModels } from '../opencode/gateway.ts';
import { parseTurnLimits, turnLimitDefaults } from '../opencode/turn-limits.ts';
import type { TurnLimits } from '../opencode/turn-limits.ts';
import type { SessionOrigin } from '../opencode/permissions.ts';
import { Ledger, telegramChatLedgerVersion, webLedgerVersion } from './ledger.ts';
import { migrateWorkItems, verifyWorkItems, WorkItems } from './work-items.ts';
import { migrateDelegations, verifyDelegations } from './delegation-schema.ts';
import { DelegationLedger, migrateBudgetChoice, verifyBudgetChoice } from './delegation-ledger.ts';
import { migrateAgentModelSources, migrateExternalHelpers, verifyAgentModelSources, verifyExternalHelpers } from './external-schema.ts';
import { ExternalLedger, externalProvider, type Provider } from './external-ledger.ts';
import { migrateReferences, ReferenceLedger, verifyReferences } from './reference-ledger.ts';
import type { WorkRequest } from './work-items.ts';
import { legacyAllowlistRef, migrateChannelAccounts, migrateTelegramSettings, verifyTelegramSettings } from '../channels/accounts.ts';
import type { ChannelAccount, LegacyChannel } from '../channels/accounts.ts';
import type { Destination } from '../channels/transport.ts';
import { validateCustomStdioMcp } from './custom-mcp.ts';
import type { CustomMcp } from './custom-mcp.ts';
import { HttpError } from '../http/errors.ts';
import { migratePlugins, pluginRegistryVersion, verifyPluginRegistry } from '../plugins/schema.ts';
import { PluginRegistry } from '../plugins/registry.ts';
import { insertLegacySessionOwner, legacyProjects, legacyWorkspace, migrateAgentLedger, replaceLegacyMcpGrants,
  verifyAgentLedger } from './agent-ledger.ts';

export const projects = legacyProjects;
export type ProjectID = typeof projects[number]['id'];

export type WebSession = { project: ProjectID; id: string; upstreamID: string; agent: Agent; alias: string; createdAt: number; title?: string | null; knowledgeDisabled?: number };
export type Attachment = { id: string; name: string; mime: string; original: FileIdentity; projection?: FileIdentity };
export type ModelSource = 'gateway' | Provider;
export type AgentSettings = {
  name?: string; introduction?: string; instructions?: string; defaultModel?: string | null; replyLocale?: 'zh-TW' | 'en';
  modelSource?: ModelSource;
  avatar?: { bytes: Buffer; mime: string } | null; knowledgeReads?: string[]; mcpGrants?: string[];
};
type WebOwner = { agentId: string; workspaceID: string; origin?: 'delegation' };
type ModelCatalog = { ids: string[]; discoveredAt: number };

const webSchema = `CREATE TABLE IF NOT EXISTS web_session_display (
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
    ) STRICT`;

export class WebStore extends Ledger {
  private readonly telegram: boolean;
  private readonly executionChanges = new Set<() => void>();
  private readonly centralWorkItems?: WorkItems;
  private readonly centralDelegations?: DelegationLedger;
  private readonly centralExternal?: ExternalLedger;
  readonly references?: ReferenceLedger;

  constructor(file: string) {
    const telegram = basename(file).toLowerCase() === 'telegram-chat.sqlite';
    super(file, {
      version: telegram ? telegramChatLedgerVersion : webLedgerVersion,
      migrate(db, version) {
        if (version < telegramChatLedgerVersion) {
          db.exec(webSchema);
          migrateAgentLedger(db, file, telegram);
        }
        if (!telegram && version < 4) migrateChannelAccounts(db);
        if (!telegram && version < 5) migrateWorkItems(db);
        if (!telegram && version < 6) migrateDelegations(db);
        if (!telegram && version < 7) migrateExternalHelpers(db);
        if (!telegram && version < 8) {
          migrateTelegramSettings(db);
          migrateBudgetChoice(db);
        }
        // The standalone v10 references branch skipped the v9 model source table.
        if (!telegram && (version < 9 || version === 10)) migrateAgentModelSources(db);
        if (!telegram && version < 10) migrateReferences(db);
        if (!telegram && version < pluginRegistryVersion) migratePlugins(db);
      },
      verify(db) {
        verifyAgentLedger(db, file, telegram);
        if (!telegram) {
          verifyWorkItems(db);
          verifyDelegations(db);
          verifyExternalHelpers(db);
          verifyTelegramSettings(db);
          verifyBudgetChoice(db);
          verifyReferences(db);
          verifyAgentModelSources(db);
          verifyPluginRegistry(db);
        }
      },
    });
    this.telegram = telegram;
    if (!telegram) {
      this.centralWorkItems = new WorkItems(this.db);
      this.centralDelegations = new DelegationLedger(this.db, this.centralWorkItems);
      this.centralExternal = new ExternalLedger(this.db);
      this.references = new ReferenceLedger(this.db, (work) => this.transaction(work));
    }
  }

  pluginRegistry(dataRoot: string, oepVersion: string) {
    return new PluginRegistry(this.db, dataRoot, oepVersion);
  }

  get workItems() {
    if (!this.centralWorkItems) throw new Error('Work items are stored in the central Web ledger');
    return this.centralWorkItems;
  }

  get runStore(): 'channel' | 'web' { return this.telegram ? 'channel' : 'web'; }

  get delegations() {
    if (!this.centralDelegations) throw new Error('Delegations are stored in the central Web ledger');
    return this.centralDelegations;
  }

  get external() {
    if (!this.centralExternal) throw new Error('External helpers are stored in the central Web ledger');
    return this.centralExternal;
  }

  verifyLegacyChannel(config: LegacyChannel, fingerprint: string, sealLegacyOwner: () => boolean) {
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT id FROM channel_accounts WHERE provider='telegram' AND account_fingerprint=?`)
        .get(fingerprint);
      if (existing && existing.id !== config.accountId) throw new Error('CHANNEL_ACCOUNT_IN_USE');
      const valid = this.db.prepare(`SELECT 1 FROM channel_accounts c JOIN agents a ON a.id=c.agent_id
        WHERE c.id=? AND c.agent_id=? AND c.handler=? AND c.provider='telegram' AND c.credential_ref=? AND c.allowlist_ref=?
        AND c.binding_revision=1 AND (c.account_fingerprint IS NULL OR c.account_fingerprint=?)
        AND c.state <> 'disabled' AND a.state='active'`).get(config.accountId, config.bot, config.handler,
        config.credentialRef, legacyAllowlistRef, fingerprint);
      if (!valid || !sealLegacyOwner()) return false;
      this.db.prepare(`UPDATE channel_accounts SET account_fingerprint=?,state='enabled',updated_at=?
        WHERE id=? AND state='unverified'`).run(fingerprint, Date.now(), config.accountId);
      return true;
    });
  }

  telegramAccounts() {
    return this.db.prepare(`SELECT id AS accountId, account_fingerprint AS fingerprint, credential_ref AS credentialRef,
      allowlist_ref AS allowlistRef, agent_id AS agentId, handler, state, binding_revision AS bindingRevision
      FROM channel_accounts WHERE provider='telegram' ORDER BY created_at,id`).all() as ChannelAccount[];
  }

  telegramAccountSettings() {
    return new Map(this.db.prepare('SELECT account_id AS id, bot_name AS botName, removed FROM telegram_account_settings')
      .all().map(({ id, botName, removed }) => [String(id), { botName: typeof botName === 'string' ? botName : undefined, removed: Boolean(removed) }]));
  }

  saveTelegramBotName(id: string, name: string) {
    this.db.prepare(`INSERT INTO telegram_account_settings (account_id,bot_name) VALUES (?,?)
      ON CONFLICT(account_id) DO UPDATE SET bot_name=excluded.bot_name WHERE bot_name IS NOT excluded.bot_name`).run(id, name);
  }

  removeTelegramAccount(account: ChannelAccount) {
    this.transaction(() => {
      this.db.prepare("UPDATE channel_accounts SET state='disabled',binding_revision=binding_revision+1,updated_at=? WHERE id=?")
        .run(Date.now(), account.accountId);
      this.db.prepare(`INSERT INTO telegram_account_settings (account_id,removed) VALUES (?,1)
        ON CONFLICT(account_id) DO UPDATE SET removed=1`).run(account.accountId);
    });
  }

  telegramAccountConflict(fingerprint: string, credentialRef: string, accountId?: string) {
    return this.db.prepare(`SELECT id AS accountId,agent_id AS agentId FROM channel_accounts
      WHERE id IS NOT ? AND (credential_ref=? OR (provider='telegram' AND account_fingerprint=?)) LIMIT 1`)
      .get(accountId ?? null, credentialRef, fingerprint) as { accountId: string; agentId: string } | undefined;
  }

  saveTelegramAccount(account: ChannelAccount, previous: ChannelAccount | undefined, sealOwner: () => void,
    createAgent?: () => void, botName?: string) {
    return this.transaction(() => {
      const conflict = this.telegramAccountConflict(account.fingerprint!, account.credentialRef, account.accountId);
      if (conflict) return conflict;
      createAgent?.();
      if (account.state === 'enabled' && !this.defaultWorkspace(account.agentId)) throw new Error('Invalid Telegram agent workspace');
      const now = Date.now();
      if (!previous) {
        this.db.prepare(`INSERT INTO channel_accounts VALUES (?,'telegram',?,?,?,?,?,'enabled',?,?,?)`).run(account.accountId,
          account.fingerprint, account.credentialRef, account.allowlistRef, account.agentId, account.handler, account.bindingRevision, now, now);
      } else {
        const { changes } = this.db.prepare(`UPDATE channel_accounts SET account_fingerprint=?,credential_ref=?,allowlist_ref=?,agent_id=?,
          handler=?,state=?,binding_revision=?,updated_at=? WHERE id=? AND binding_revision=?`)
          .run(account.fingerprint, account.credentialRef, account.allowlistRef, account.agentId, account.handler, account.state,
            account.bindingRevision, now, account.accountId, previous.bindingRevision);
        if (!changes) throw new Error('Stale Telegram binding');
      }
      if (botName) this.saveTelegramBotName(account.accountId, botName);
      this.db.prepare('UPDATE telegram_account_settings SET removed=0 WHERE account_id=? AND removed=1').run(account.accountId);
      sealOwner();
    });
  }

  channelLocale(agentID: string): 'zh-TW' | 'en' {
    return this.db.prepare('SELECT reply_locale FROM agents WHERE id=?').get(agentID)?.reply_locale === 'en' ? 'en' : 'zh-TW';
  }

  agents() {
    return this.db.prepare(`SELECT id, role, builtin_key AS builtin, state, name, introduction, instructions,
      avatar IS NOT NULL AS hasAvatar, default_model_id AS defaultModel, reply_locale AS replyLocale,
      COALESCE((SELECT source FROM agent_model_sources WHERE agent_id=agents.id), 'gateway') AS modelSource,
      config_revision AS revision FROM agents WHERE id NOT IN ('external-codex-cli','external-claude-code')
      ORDER BY builtin_key IS NULL, id<>'main', created_at, id`).all() as {
        id: string; role: 'orchestrator' | 'specialist'; builtin: 'main' | 'bi' | null; state: 'active' | 'archived';
        name: string; introduction: string; instructions: string; hasAvatar: number; defaultModel: string | null;
        modelSource: ModelSource; replyLocale: 'zh-TW' | 'en'; revision: number;
      }[];
  }

  agentWorkspaces(agentID: string) {
    return this.db.prepare(`SELECT id, layout, relative_root AS relativeRoot, is_default AS isDefault, classification FROM agent_workspaces
      WHERE agent_id=? ORDER BY is_default DESC,id`).all(agentID).map((row) => ({
      ...row as { id: string; layout: string; relativeRoot: string; isDefault: number },
      folders: this.db.prepare('SELECT folder FROM workspace_read_folders WHERE workspace_id=? ORDER BY folder')
        .all(row.id).map(({ folder }) => String(folder)),
    }));
  }

  agentStatus(agentID: string) {
    const rows = this.db.prepare(`SELECT DISTINCT r.state FROM session_ownership o JOIN web_turns t ON t.session_id=o.session_id
      JOIN runs r ON r.id=t.run_id WHERE o.agent_id=? AND r.state NOT IN ('verified','failed','cancelled')`).all(agentID);
    return rows.some(({ state }) => state !== 'accepted') ? 'busy' : rows.length ? 'queued' : 'available';
  }

  agentAvatar(id: string) {
    return this.db.prepare('SELECT avatar, avatar_mime AS mime FROM agents WHERE id=? AND avatar IS NOT NULL').get(id) as
      { avatar: Uint8Array; mime: string } | undefined;
  }

  agentBindings(id: string) {
    return {
      knowledgeReads: this.db.prepare('SELECT vault_id AS id FROM agent_knowledge_reads WHERE agent_id=? ORDER BY id')
        .all(id).map(({ id }) => String(id)),
      mcpGrants: this.db.prepare("SELECT capability_id AS id FROM agent_capabilities WHERE agent_id=? AND kind='mcp' AND enabled=1 ORDER BY id")
        .all(id).map(({ id }) => String(id)),
      writeTargets: this.db.prepare('SELECT target_id AS id, target_kind AS kind FROM agent_write_targets WHERE agent_id=? ORDER BY id')
        .all(id),
    };
  }

  private saveAgentBindings(id: string, settings: AgentSettings) {
    if (settings.modelSource === 'gateway') this.db.prepare('DELETE FROM agent_model_sources WHERE agent_id=?').run(id);
    else if (settings.modelSource) this.db.prepare(`INSERT INTO agent_model_sources (agent_id,source) VALUES (?,?)
      ON CONFLICT(agent_id) DO UPDATE SET source=excluded.source`).run(id, settings.modelSource);
    if (settings.knowledgeReads) {
      this.db.prepare('DELETE FROM agent_knowledge_reads WHERE agent_id=?').run(id);
      const add = this.db.prepare('INSERT INTO agent_knowledge_reads VALUES (?,?)');
      for (const vault of settings.knowledgeReads) add.run(id, vault);
    }
    if (settings.mcpGrants) {
      if (id === 'main' && !this.hasExplicitMainMcpGrants()) this.auditSettings('agent-mcp-main');
      this.db.prepare("DELETE FROM agent_capabilities WHERE agent_id=? AND kind='mcp'").run(id);
      this.db.prepare('DELETE FROM workspace_mcp_grants WHERE workspace_id IN (SELECT id FROM agent_workspaces WHERE agent_id=?)').run(id);
      const grant = this.db.prepare("INSERT INTO agent_capabilities VALUES (?,'mcp',?,1)");
      const workspace = this.db.prepare('INSERT INTO workspace_mcp_grants VALUES (?,?)');
      const definitions = this.customMcpServers();
      for (const server of settings.mcpGrants) {
        grant.run(id, server);
        const applies = definitions.find(({ id }) => id === server)?.appliesToProjects ?? [];
        for (const folder of this.agentWorkspaces(id)) {
          if (applies.includes(folder.layout === 'legacy_secondary' ? 'secondary' : 'default')) workspace.run(folder.id, server);
        }
      }
    }
  }

  // The channel registry supplies its transaction when the wizard binds a bot.
  agentCreation(id: string, settings: AgentSettings, validate: () => void) {
    return () => {
      validate();
      const now = Date.now();
      this.db.prepare(`INSERT INTO agents VALUES (?,'specialist',NULL,'active',?,?,?,?,?,?,?,1,?,?)`).run(id,
        settings.name!, settings.introduction ?? '', settings.instructions ?? '', settings.avatar?.bytes ?? null,
        settings.avatar?.mime ?? null, settings.defaultModel ?? null, settings.replyLocale ?? 'zh-TW', now, now);
      this.db.prepare("INSERT INTO agent_workspaces VALUES (?,?,'managed',?,NULL,1,'unclassified',?)")
        .run(id, id, 'web/agents/' + id, now);
      this.db.prepare('INSERT INTO agent_trigger_settings VALUES (?,1)').run(id);
      this.saveAgentBindings(id, settings);
    };
  }

  createAgent(create: () => void) { this.transaction(create); }

  updateAgent(id: string, revision: number, settings: AgentSettings | null, channelStatus: string, unbindChannels = false) {
    this.transaction(() => {
      const agent = this.agents().find((agent) => agent.id === id);
      if (!agent) throw new HttpError(404, 'agent-not-found');
      if (agent.revision !== revision) throw new HttpError(409, 'agent-revision-conflict');
      if (agent.state !== 'active') throw new HttpError(409, 'agent-inactive');
      if (settings?.modelSource && settings.modelSource !== agent.modelSource &&
          (this.agentStatus(id) !== 'available' || channelStatus !== 'available' ||
            this.db.prepare("SELECT 1 FROM agent_work_items WHERE agent_id=? AND (state='queued' OR lease_id IS NOT NULL) LIMIT 1").get(id))) {
        throw new HttpError(409, 'model-change-busy');
      }
      if (!settings) {
        if (agent.builtin) throw new HttpError(409, 'agent-builtin');
        if (!unbindChannels && this.telegramAccounts().some((row) => row.agentId === id && row.state === 'enabled')) {
          throw new HttpError(409, 'agent-channel-bound');
        }
        const work = this.db.prepare("SELECT 1 FROM agent_work_items WHERE agent_id=? AND (state='queued' OR lease_id IS NOT NULL) LIMIT 1").get(id);
        if (work || this.agentStatus(id) !== 'available' || channelStatus !== 'available') throw new HttpError(409, 'agent-busy');
        if (unbindChannels) this.db.prepare(`UPDATE channel_accounts SET state='disabled',binding_revision=binding_revision+1,updated_at=?
          WHERE agent_id=? AND state<>'disabled'`).run(Date.now(), id);
        this.db.prepare("UPDATE agents SET state='archived',config_revision=config_revision+1,updated_at=? WHERE id=?")
          .run(Date.now(), id);
        return;
      }
      const name = settings.name ?? agent.name;
      const intro = settings.introduction ?? agent.introduction;
      const instructions = settings.instructions ?? agent.instructions;
      this.db.prepare(`UPDATE agents SET name=?, introduction=?, instructions=?, default_model_id=?, reply_locale=?,
        config_revision=config_revision+1, updated_at=? WHERE id=?`).run(name, intro, instructions,
        settings.defaultModel === undefined ? agent.defaultModel : settings.defaultModel, settings.replyLocale ?? agent.replyLocale, Date.now(), id);
      if (settings.avatar !== undefined) this.db.prepare('UPDATE agents SET avatar=?,avatar_mime=? WHERE id=?')
        .run(settings.avatar?.bytes ?? null, settings.avatar?.mime ?? null, id);
      this.saveAgentBindings(id, settings);
      if (id === 'main') {
        this.writePreferences(name, intro, instructions);
        if (settings.avatar !== undefined) this.writeAppearanceAvatar(settings.avatar);
      }
      this.auditSettings('assistant');
    });
    this.executionChanges.forEach((check) => check());
  }

  restoreAgent(id: string, revision: number) {
    this.transaction(() => {
      const agent = this.agents().find((agent) => agent.id === id);
      if (!agent) throw new HttpError(404, 'agent-not-found');
      if (agent.revision !== revision) throw new HttpError(409, 'agent-revision-conflict');
      if (agent.builtin || agent.state !== 'archived') throw new HttpError(409, 'agent-inactive');
      this.db.prepare("UPDATE agents SET state='active',config_revision=config_revision+1,updated_at=? WHERE id=?")
        .run(Date.now(), id);
    });
    this.executionChanges.forEach((check) => check());
  }

  defaultWorkspace(agentID: string) {
    if (externalProvider(agentID) || !/^[a-z\d][a-z\d_-]{0,79}$/.test(agentID)) return;
    return this.db.prepare(`SELECT w.id FROM agent_workspaces w JOIN agents a ON a.id=w.agent_id
      WHERE a.id=? AND w.is_default=1 AND a.state='active' AND
        ((a.id='main' AND w.id='legacy-default' AND w.relative_root='web') OR
         (a.id<>'main' AND w.layout='managed' AND w.relative_root='web/agents/'||a.id))`).get(agentID)?.id as string | undefined;
  }

  openChannelRuns(accountId: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM session_ownership o JOIN web_turns t ON o.session_id=t.session_id
      JOIN runs r ON r.id=t.run_id WHERE o.channel_account_id=? AND r.state NOT IN ('verified','failed','cancelled') LIMIT 1`).get(accountId));
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
    const saved = this.transaction(() => {
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
      if (!this.telegram) replaceLegacyMcpGrants(this.db, definition, this.hasExplicitMainMcpGrants());
      return { ...definition, createdAt, updatedAt: now };
    });
    this.executionChanges.forEach((check) => check());
    return saved;
  }

  removeCustomMcp(id: string) {
    const removed = this.transaction(() => {
      if (!this.telegram) {
        this.db.prepare('DELETE FROM workspace_mcp_grants WHERE server_id = ?').run(id);
        this.db.prepare("DELETE FROM agent_capabilities WHERE kind='mcp' AND capability_id = ?").run(id);
      }
      return Boolean(this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes);
    });
    if (removed) this.executionChanges.forEach((check) => check());
    return removed;
  }

  onExecutionChange(check: () => void) {
    this.executionChanges.add(check);
    return () => { this.executionChanges.delete(check); };
  }

  private hasExplicitMainMcpGrants() {
    return Boolean(this.db.prepare("SELECT 1 FROM web_settings_audit WHERE section='agent-mcp-main' LIMIT 1").get());
  }

  knowledgeSettings() {
    const row = this.db.prepare('SELECT atlas_url AS atlasUrl, toolbox FROM web_knowledge_settings WHERE id=1').get();
    return { atlasUrl: String(row?.atlasUrl ?? ''), toolbox: row?.toolbox !== 0 };
  }

  sessionOwner(session: WebSession) {
    return this.db.prepare(`SELECT o.agent_id AS agentID, o.workspace_id AS workspaceID, o.origin,
      o.channel_account_id AS channelAccount, o.conversation_key AS conversationKey, o.binding_revision AS bindingRevision
      FROM session_ownership o JOIN web_sessions s ON s.id=o.session_id
      LEFT JOIN web_session_project p ON p.id=s.id
      LEFT JOIN web_session_display d ON d.id=s.id
      WHERE s.id=? AND s.upstream_id=? AND s.agent=? AND s.alias=? AND COALESCE(p.project,'default')=?
        AND COALESCE(d.removed,0)=0`)
      .get(session.id, session.upstreamID, session.agent, session.alias, session.project) as {
        agentID: string; workspaceID: string; origin: SessionOrigin;
        channelAccount: string | null; conversationKey: string | null; bindingRevision: number | null;
      } | undefined;
  }

  executionProfile(agentID: string, workspaceID: string, includeArchived = false) {
    return this.db.prepare(`SELECT a.config_revision AS revision, a.name, a.introduction, a.instructions, a.reply_locale AS replyLocale,
      a.default_model_id AS defaultModel, w.relative_root AS relativeRoot,
      COALESCE(w.display_name,w.id) AS workspaceName
      FROM agents a JOIN agent_workspaces w ON w.agent_id=a.id
      WHERE a.id=? AND w.id=? AND (a.state='active' OR ?)`).get(agentID, workspaceID, Number(includeArchived)) as {
        revision: number; name: string; introduction: string; instructions: string; replyLocale: 'zh-TW' | 'en';
        defaultModel: string | null; relativeRoot: string; workspaceName: string;
      } | undefined;
  }

  agentModelSource(agentID: string): ModelSource {
    return this.db.prepare('SELECT source FROM agent_model_sources WHERE agent_id=?').get(agentID)?.source as Provider ?? 'gateway';
  }

  executionMcpGrants(agentID: string, workspaceID: string) {
    const grants = this.db.prepare(`SELECT g.server_id AS id FROM workspace_mcp_grants g
      JOIN agent_capabilities a ON a.capability_id=g.server_id
      WHERE g.workspace_id=? AND a.agent_id=? AND a.kind='mcp' AND a.enabled=1`).all(workspaceID, agentID);
    const ids = new Set(grants.map(({ id }) => id));
    return this.customMcpServers().filter(({ enabled, id }) => enabled && ids.has(id));
  }

  executionKnowledgeReads(agentID: string, workspaceID: string) {
    return this.db.prepare(`SELECT r.vault_id AS vault FROM agent_knowledge_reads r
      JOIN agents a ON a.id=r.agent_id JOIN agent_workspaces w ON w.agent_id=a.id
      WHERE a.id=? AND w.id=? AND a.state='active' ORDER BY r.vault_id`).all(agentID, workspaceID)
      .map(({ vault }) => String(vault));
  }

  saveKnowledgeSettings(atlasUrl: string, toolbox: boolean) {
    this.db.prepare('INSERT OR REPLACE INTO web_knowledge_settings VALUES (1, ?, ?)').run(atlasUrl, Number(toolbox));
    this.executionChanges.forEach((check) => check());
  }

  projectFolders() {
    return this.db.prepare('SELECT project, folder FROM web_project_folders ORDER BY folder')
      .all() as { project: ProjectID; folder: string }[];
  }

  addProjectFolder(project: ProjectID, folder: string) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO web_project_folders VALUES (?, ?)').run(project, folder);
      if (!this.telegram) this.db.prepare('INSERT INTO workspace_read_folders VALUES (?, ?)').run(legacyWorkspace(project), folder);
    });
  }

  removeProjectFolder(project: ProjectID, folder: string) {
    return this.transaction(() => {
      if (!this.telegram) {
        this.db.prepare('DELETE FROM workspace_read_folders WHERE workspace_id = ? AND folder = ?')
          .run(legacyWorkspace(project), folder);
      }
      return this.db.prepare('DELETE FROM web_project_folders WHERE project = ? AND folder = ?').run(project, folder).changes > 0;
    });
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

  hasAnnotation(sessionID: string, messageID: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM web_message_annotations WHERE session_id = ? AND message_id = ?')
      .get(sessionID, messageID));
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
      this.writePreferences(name, introduction, instructions);
      if (!this.telegram) this.db.prepare(`UPDATE agents SET name = ?, introduction = ?, instructions = ?,
        config_revision = config_revision + 1, updated_at = ? WHERE id = 'main'`)
        .run(name, introduction, instructions, Date.now());
      this.auditSettings('assistant');
    });
  }

  private writePreferences(name: string, introduction: string, instructions: string) {
    this.db.prepare(`INSERT INTO web_preferences VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, introduction = excluded.introduction, instructions = excluded.instructions`)
      .run(name, introduction, instructions);
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
        this.writeAppearanceAvatar(image);
        if (!this.telegram) this.db.prepare(`UPDATE agents SET avatar = ?, avatar_mime = ?,
          config_revision = config_revision + 1, updated_at = ? WHERE id = 'main'`)
          .run(image?.bytes ?? null, image?.mime ?? null, Date.now());
      }
      this.auditSettings('appearance');
    });
  }

  private writeAppearanceAvatar(image: NonNullable<AgentSettings['avatar']> | null) {
    this.db.prepare(`INSERT INTO web_appearance (id,theme,density,avatar,mime) VALUES (1,'system','comfortable',?,?)
      ON CONFLICT(id) DO UPDATE SET avatar=excluded.avatar,mime=excluded.mime`).run(image?.bytes ?? null, image?.mime ?? null);
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

  createSession(session: Omit<WebSession, 'project'> & Partial<Pick<WebSession, 'project'>>,
    channel?: number | (Destination & { workspaceID: string }), owner?: WebOwner) {
    this.transaction(() => {
      const project = session.project ?? 'default';
      this.db.prepare('INSERT INTO web_sessions VALUES (?, ?, ?, ?, ?)')
        .run(session.id, session.upstreamID, session.agent, session.alias, session.createdAt);
      if (session.knowledgeDisabled) this.db.prepare('INSERT INTO web_session_knowledge_disabled VALUES (?)').run(session.id);
      this.db.prepare('INSERT INTO web_session_project VALUES (?, ?)').run(session.id, project);
      if (typeof channel === 'object') {
        this.db.prepare("INSERT INTO session_ownership VALUES (?,?,?,'channel',?,?,?)").run(session.id,
          channel.agentId, channel.workspaceID, channel.accountId, channel.conversationKey, channel.bindingRevision);
      } else if (owner) {
        if (!this.executionProfile(owner.agentId, owner.workspaceID)) throw new HttpError(409, 'agent-inactive');
        this.db.prepare('INSERT INTO session_ownership VALUES (?,?,?,?,NULL,NULL,NULL)')
          .run(session.id, owner.agentId, owner.workspaceID, owner.origin ?? 'web');
      } else insertLegacySessionOwner(this.db, session.id, project, this.telegram || channel !== undefined, channel);
    });
  }

  sessions(includeHidden = false, id?: string) {
    return this.db.prepare(`SELECT s.id, upstream_id AS upstreamID, agent, alias, created_at AS createdAt, d.title,
      COALESCE(p.project, 'default') AS project, k.id IS NOT NULL AS knowledgeDisabled
      FROM web_sessions s LEFT JOIN web_session_display d ON d.id = s.id
      LEFT JOIN web_session_project p ON p.id = s.id
      LEFT JOIN web_session_knowledge_disabled k ON k.id = s.id
      WHERE (? OR COALESCE(d.removed, 0) = 0) AND (? IS NULL OR s.id=?) ORDER BY created_at, s.id`)
      .all(Number(includeHidden), id ?? null, id ?? null) as WebSession[];
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

  saveAttachment(sessionID: string, record: Attachment, ownerUpload = false) {
    const bytes = record.original.bytes + (record.projection?.bytes ?? 0);
    const save = () => this.db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?)').run(record.id, sessionID, bytes, JSON.stringify(record));
    if (ownerUpload && this.centralExternal) {
      this.transaction(() => {
        save();
        const owner = this.db.prepare("SELECT workspace_id FROM session_ownership WHERE session_id=? AND origin='web'").get(sessionID);
        if (typeof owner?.workspace_id === 'string') this.external.addSource(sessionID, owner.workspace_id, { kind: 'attachment', attachmentId: record.id });
      });
    } else save();
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

  saveTurn(sessionID: string, run: RunRecord, hash: string, reply?: { id: string; text: string }, work?: WorkRequest,
    delegationId?: string) {
    this.transaction(() => {
      this.insert(run);
      this.db.prepare('INSERT INTO web_turns VALUES (?, ?, ?)').run(sessionID, run.id, hash);
      if (reply) this.db.prepare('INSERT INTO web_turn_replies VALUES (?, ?, ?)').run(run.id, reply.id, reply.text);
      if (work) this.workItems.enqueue(work, run.createdAt);
      if (delegationId) this.delegations.bindChild(delegationId, sessionID, run.id);
    });
  }

  turns(sessionID: string) {
    return this.db.prepare(
      'SELECT r.record FROM web_turns t JOIN runs r ON r.id = t.run_id WHERE t.session_id = ? ORDER BY t.rowid',
    ).all(sessionID).map((row) => JSON.parse(String(row.record)) as RunRecord);
  }
}
