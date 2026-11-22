import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { legacyAgentRows } from '../../apps/adapter/src/runs/agent-ledger.ts';
import { historicalKnowledgeStore, knowledgeStorePath } from '../fixtures/upgrade/historical-knowledge.ts';
import { artifactPath, attachmentPath, fixtureMcpId, seedPhase3bFixture } from '../fixtures/upgrade/phase3b.ts';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';

// Tables present before any upgrade-tracked addition; everything else must be allow-listed.
const original = new Set(['runs', 'run_events']);

function allowedEmptyTables(name: string) {
  const source = readFileSync('scripts/windows/data-snapshot.mjs', 'utf8');
  const body = source.match(new RegExp('const ' + name + ' = new Set\\(\\[([\\s\\S]*?)\\]\\);'));
  assert.ok(body, name + ' allowlist not found');
  return [...body[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function run(file: string, args: string[], failure?: RegExp, release?: string) {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...args],
    { encoding: 'utf8', timeout: 15_000, cwd: release,
      env: release ? { ...process.env, OEP_REPO_ROOT: release } : process.env });
  assert.ifError(result.error);
  assert.equal(result.status, failure ? 1 : 0, result.stderr);
  if (failure) assert.match(result.stderr, failure);
  return result.stdout;
}

const snapshot = 'scripts/windows/data-snapshot.mjs';
const migrate = (data: string, failure?: RegExp) => run('scripts/windows/migrate-data.ts', [data], failure);
const backup = (data: string, copy: string) => {
  run(snapshot, ['copy', data, copy]);
  run(snapshot, ['describe', copy, join(copy, 'backup.manifest.json')]);
};

test('every web store table is accepted by the upgrade reconciliation allowlist', () => {
  mkdirSync('.phase0', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.phase0', 'upgrade-allowlist-'));
  try {
    const file = join(root, 'web.sqlite');
    new WebStore(file).close();
    const db = new DatabaseSync(file, { readOnly: true });
    let tables: string[];
    try {
      tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .map((row) => row.name);
    } finally { db.close(); }
    const allowed = new Set([...allowedEmptyTables('webAdditions'), ...allowedEmptyTables('webV3Empty'),
      ...Object.keys(legacyAgentRows(undefined, root, false))]);
    const missing = tables.filter((name) => !original.has(name) && !allowed.has(name));
    assert.deepEqual(missing, [], 'Register new Web tables for empty-table or seeded-data reconciliation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pre-model WebStore schema migrates from an actual old snapshot and reconciles', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-previous-schema-'));
  try {
    const data = join(root, 'data');
    const copy = join(root, 'backup');
    const file = join(data, 'web', 'web.sqlite');
    mkdirSync(join(data, 'web'), { recursive: true });
    {
      using db = new DatabaseSync(file);
      db.exec(readFileSync(new URL('../fixtures/upgrade/web-before-model-selection.sql', import.meta.url), 'utf8'));
    }
    backup(data, copy);
    const migration = JSON.parse(migrate(data))['web/web.sqlite'];
    for (const table of ['web_model_catalog', 'web_model_selection']) {
      assert.equal(Object.hasOwn(migration.before.counts, table), false);
      assert.equal(migration.after.counts[table], 0);
    }
    assert.equal(migration.before.counts.runs, 1);
    assert.equal(migration.before.counts.run_events, 1);
    assert.equal(migration.before.counts.web_sessions, 1);
    run(snapshot, ['reconcile-upgrade', data, copy]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Phase 3B reconciles all pre-slice ledgers twice and rejects changed data', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-phase3b-upgrade-'));
  try {
    const data = join(root, 'data');
    const copy = join(root, 'backup');
    const { web, avatar, original, projection, artifact } = seedPhase3bFixture(data);
    backup(data, copy);
    const result = JSON.parse(migrate(data));
    const reconcile = (failure?: RegExp) => run(snapshot, ['reconcile-upgrade', data, copy], failure);
    const expectedVersions = { web: [2, 3], 'telegram-chat': [2, 3], knowledge: [1, 2], telegram: [1, 2] };
    for (const [name, versions] of Object.entries(expectedVersions)) {
      const { before, after } = result['web/' + name + '.sqlite'];
      assert.deepEqual([before.userVersion, after.userVersion], versions);
    }
    assert.ok(existsSync(join(web, 'agents/bi/model-work')));
    reconcile();
    {
      using db = new DatabaseSync(join(web, 'knowledge.sqlite'));
      db.exec('PRAGMA user_version=1');
      reconcile(/【web\/knowledge.sqlite】.*SQLite user_version 與新版不符/);
      db.exec('PRAGMA user_version=2');
    }
    const repeat = JSON.parse(migrate(data));
    for (const { before, after } of Object.values(repeat) as { before: unknown; after: unknown }[]) {
      assert.deepEqual(after, before);
    }
    reconcile();

    using sessions = new DatabaseSync(join(web, 'web.sqlite'));
    const query = (sql: string) => sessions.prepare(sql).all().map((row) => Object.values(row));
    const assistant = query(`SELECT name, introduction, instructions, avatar, avatar_mime, default_model_id, reply_locale
      FROM agents WHERE id='main'`)[0];
    assert.deepEqual(assistant, ['Synthetic assistant', 'Synthetic introduction', 'Synthetic instructions',
      Uint8Array.from(avatar), 'image/png', null, 'zh-TW']);
    assert.deepEqual(query('SELECT alias FROM web_model_settings'), [['synthetic-secondary']]);
    assert.deepEqual(query('SELECT id, agent_id, relative_root, is_default FROM agent_workspaces ORDER BY id'),
      [['bi', 'bi', 'web/agents/bi', 1], ['legacy-default', 'main', 'web', 1], ['legacy-secondary', 'main', 'web/secondary', 0]]);
    assert.deepEqual(query('SELECT session_id, agent_id, workspace_id, origin FROM session_ownership ORDER BY session_id'),
      [['hidden', 'main', 'legacy-secondary', 'web'], ['visible', 'main', 'legacy-default', 'web']]);
    assert.deepEqual(query('SELECT * FROM agent_knowledge_reads ORDER BY agent_id'), [['bi', 'synthetic-bench'], ['main', 'synthetic-bench']]);
    assert.deepEqual(query('SELECT * FROM agent_write_targets'), [['bi', 'knowledge', 'synthetic-bench', 'proposal_only']]);
    assert.deepEqual(query('SELECT * FROM workspace_read_folders ORDER BY workspace_id'),
      [['legacy-default', join(data, 'external-default')], ['legacy-secondary', join(data, 'external-secondary')]]);
    assert.deepEqual(query('SELECT * FROM workspace_mcp_grants ORDER BY workspace_id'),
      [['legacy-default', fixtureMcpId], ['legacy-secondary', fixtureMcpId]]);
    assert.deepEqual(query('SELECT * FROM agent_capabilities'), [['main', 'mcp', fixtureMcpId, 0]]);
    assert.deepEqual(query('SELECT * FROM agent_trigger_settings ORDER BY agent_id'), [['bi', 1], ['main', 1]]);
    assert.deepEqual(query('SELECT * FROM file_classifications'), []);
    const attachment = JSON.parse(String(query('SELECT record FROM attachments')[0][0]));
    assert.deepEqual(attachment.original, original);
    assert.deepEqual(attachment.projection, projection);
    assert.equal(JSON.parse(String(query("SELECT record FROM runs WHERE id='hidden-run'")[0][0])).artifacts[0].sha256, artifact.sha256);
    {
      using db = new DatabaseSync(join(web, 'telegram-chat.sqlite'), { readOnly: true });
      assert.deepEqual(db.prepare('SELECT * FROM session_ownership ORDER BY session_id').all().map((row) => Object.values(row)), [
        ['telegram-session', 'main', 'legacy-default', 'channel', 'telegram-main', 'topic:17', 1],
        ['unbound-session', 'main', 'legacy-default', 'channel', 'telegram-main', 'legacy-session:unbound-session', 1],
      ]);
    }
    {
      using db = new DatabaseSync(join(web, 'knowledge.sqlite'), { readOnly: true });
      assert.equal(db.prepare("SELECT status FROM reviews WHERE id='pending-bi'").get()?.status, 'pending');
      assert.equal(db.prepare('SELECT revision FROM publications').get()?.revision, 'gold.v2');
    }
    {
      using spool = new DatabaseSync(join(web, 'telegram.sqlite'));
      const rows = (sql: string) => spool.prepare(sql).all().map((row) => Object.values(row));
      assert.deepEqual(rows('SELECT account_id,checkpoint FROM channel_cursors ORDER BY account_id'),
        [['telegram-bi', '11'], ['telegram-main', '8']]);
      assert.deepEqual(rows(`SELECT event_key,conversation_key,status,received_at,first_attempt_at,attempts,due_at
        FROM channel_inbound WHERE account_id='telegram-bi' ORDER BY rowid`),
      [['9', 'topic:2', 'failed', 100, 200, 20, 120200], ['10', 'topic:3', 'handled', 100, 200, 2, 6000],
        ['11', 'topic:3', 'pending', 300, 400, 3, 6400]]);
      assert.deepEqual(rows('SELECT effect_key,state FROM channel_outbound ORDER BY rowid'), [
        ['original', 'pending'], ['previous-bi', 'indeterminate'], ['interrupted-bi', 'sending'], ['already-sent-bi', 'sent'],
      ]);
      spool.exec("UPDATE channel_inbound SET agent_id='main' WHERE account_id='telegram-bi' AND event_key='11'");
      reconcile(/【web\/telegram.sqlite】.*channel_inbound/);
      spool.exec("UPDATE channel_inbound SET agent_id='bi' WHERE account_id='telegram-bi' AND event_key='11'");
      spool.exec('DELETE FROM channel_conversations');
      reconcile(/【web\/telegram.sqlite】.*channel_conversations/);
      spool.exec("INSERT INTO channel_conversations VALUES ('telegram-main','topic:17',1,'bi','telegram-session')");
      reconcile(/【web\/telegram.sqlite】.*channel_conversations/);
      migrate(data, /【web\/telegram.sqlite】.*通道會話歸屬檢查失敗/);
      spool.exec("UPDATE channel_conversations SET agent_id='main'");
    }
    sessions.exec("DELETE FROM session_ownership WHERE session_id='hidden'");
    reconcile(/【web\/web.sqlite】.*session_ownership/);
    sessions.exec("INSERT INTO session_ownership VALUES ('hidden','main','legacy-default','web',NULL,NULL,NULL)");
    reconcile(/【web\/web.sqlite】.*session_ownership/);
    sessions.exec("UPDATE session_ownership SET workspace_id='legacy-secondary' WHERE session_id='hidden'");
    {
      using chat = new DatabaseSync(join(web, 'telegram-chat.sqlite'));
      chat.exec("UPDATE session_ownership SET agent_id='bi', workspace_id='bi' WHERE session_id='telegram-session'");
      reconcile(/【web\/telegram-chat.sqlite】.*session_ownership/);
      chat.exec("UPDATE session_ownership SET agent_id='main', workspace_id='legacy-default' WHERE session_id='telegram-session'");
    }
    sessions.exec('CREATE TABLE rogue (id INTEGER); INSERT INTO rogue VALUES (1)');
    reconcile(/【web\/web.sqlite】.*未列入允許清單/);
    sessions.exec('DROP TABLE rogue');
    const path = join(data, attachmentPath);
    const bytes = readFileSync(path);
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    writeFileSync(path, changed);
    reconcile(/【web\/secondary\/sessions\/hidden\/attachments\/synthetic.txt】.*SHA-256/);
    writeFileSync(path, bytes);
    assert.deepEqual(readFileSync(join(data, artifactPath)), readFileSync(join(copy, artifactPath)));
    reconcile();
    const difference = join(root, 'intent-diff.json');
    run(snapshot, ['intent-diff', data, copy, difference]);
    assert.deepEqual(JSON.parse(readFileSync(difference, 'utf8')).changes, []);
    const inbox = new TelegramInbox(join(web, 'telegram.sqlite'));
    try {
      assert.equal(inbox.db.prepare("SELECT state FROM channel_outbound WHERE effect_key='interrupted-bi'").get()?.state, 'indeterminate');
      assert.equal(inbox.db.prepare("SELECT state FROM outbox WHERE id='interrupted-bi'").get()?.state, 'sending');
      run(snapshot, ['intent-diff', data, copy, difference]);
      const { changes } = JSON.parse(readFileSync(difference, 'utf8'));
      assert.equal(changes.length, 1);
      assert.equal(changes[0].table, 'channel_outbound');
      assert.equal(changes[0].addedOrChanged.length, 1);
    } finally { inbox.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Telegram spool migration rolls back all additions on a bad row and resumes on retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-channel-rollback-'));
  try {
    const { web } = seedPhase3bFixture(root);
    using db = new DatabaseSync(join(web, 'telegram.sqlite'));
    db.exec("UPDATE inbox SET payload='invalid JSON' WHERE bot='bi' AND id=9");
    migrate(root, /【web\/telegram.sqlite】.*套用 SQLite 結構遷移失敗/);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'channel_%'").all(), []);
    assert.equal(db.prepare("SELECT payload FROM inbox WHERE bot='bi' AND id=9").get()?.payload, 'invalid JSON');
    {
      using sessions = new DatabaseSync(join(web, 'telegram-chat.sqlite'), { readOnly: true });
      assert.equal(sessions.prepare('PRAGMA user_version').get()?.user_version, 3);
    }
    db.exec("UPDATE inbox SET payload='{}' WHERE bot='bi' AND id=9");
    migrate(root);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(db.prepare('SELECT count(*) AS total FROM channel_inbound').get()?.total, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same-version repair reconciles the historical candidate schema and rejects a wrong version', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-phase3b-repair-'));
  try {
    const data = join(root, 'data');
    const copy = join(root, 'backup');
    const release = join(root, 'candidate');
    for (const path of ['package.json', 'apps/adapter', 'apps/launcher/src/paths.ts', 'packages', 'scripts/windows', 'scripts/phase0']) {
      cpSync(path, join(release, path), { recursive: true });
    }
    const store = join(release, knowledgeStorePath);
    writeFileSync(store, historicalKnowledgeStore(readFileSync(store, 'utf8')));
    const { web } = seedPhase3bFixture(data);
    backup(data, copy);
    const migration = JSON.parse(run('scripts/windows/migrate-data.ts', [data], undefined, release));
    const knowledge = migration['web/knowledge.sqlite'];
    assert.equal(knowledge.before.userVersion, 1);
    assert.deepEqual(knowledge.after, knowledge.before);
    const reconcile = (failure?: RegExp) => run(snapshot, ['reconcile-upgrade', data, copy], failure, release);
    reconcile();

    using db = new DatabaseSync(join(web, 'knowledge.sqlite'));
    db.exec('PRAGMA user_version=2');
    reconcile(/【web\/knowledge.sqlite】.*SQLite user_version 與新版不符/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconciliation accepts only the expected central database when the old Web DB was missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-phase3b-missing-web-'));
  try {
    const data = join(root, 'data');
    const copy = join(root, 'backup');
    const { web } = seedPhase3bFixture(data);
    rmSync(join(web, 'web.sqlite'));
    backup(data, copy);
    assert.equal(JSON.parse(migrate(data))['web/web.sqlite'].before, null);
    run(snapshot, ['reconcile-upgrade', data, copy]);
    new WebStore(join(data, 'web.sqlite')).close();
    run(snapshot, ['reconcile-upgrade', data, copy], /【web.sqlite】.*未預期的受管資料庫/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
