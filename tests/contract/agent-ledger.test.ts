import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { fixtureMcpId, seedPhase3bFixture } from '../fixtures/upgrade/phase3b.ts';

function directory(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'oep-agent-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const version = (db: DatabaseSync) => db.prepare('PRAGMA user_version').get()?.user_version;
const table = (db: DatabaseSync, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
const values = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((row) => Object.values(row));

function migrate(root: string, failure?: RegExp) {
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/windows/migrate-data.ts', root],
    { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(run.error);
  assert.equal(run.status, failure ? 1 : 0, run.stderr);
  if (failure) assert.match(run.stderr, failure);
  return run.stdout;
}

test('fresh stores seed built-ins and enforce identity, default workspace, classification and STRICT contracts', (t) => {
  const root = directory(t);
  assert.deepEqual(JSON.parse(migrate(root)), {});
  const file = join(root, 'web.sqlite');
  new WebStore(file).close();
  const chatPath = join(root, 'telegram-chat.sqlite');
  const chat = new WebStore(chatPath);
  try {
    chat.createSession({ id: 'topic-session', upstreamID: 'topic-upstream', agent: 'inspector', alias: 'synthetic', createdAt: 1 }, 0);
  } finally { chat.close(); }
  const knowledgePath = join(root, 'knowledge.sqlite');
  new KnowledgeStore(knowledgePath).close();
  assert.equal(migrate(root), migrate(root));
  assert.ok(existsSync(join(root, 'web/agents/bi/sessions')));
  using db = new DatabaseSync(file);
  using telegram = new DatabaseSync(chatPath);
  using knowledge = new DatabaseSync(knowledgePath);
  assert.deepEqual([version(db), version(telegram), version(knowledge)], [9, 3, 3]);
  assert.deepEqual(values(db, 'SELECT id, role, state, name, default_model_id, reply_locale FROM agents ORDER BY id'), [
    ['bi', 'specialist', 'active', 'BI 資料處理', null, 'zh-TW'],
    ['main', 'orchestrator', 'active', '', null, 'zh-TW'],
  ]);
  assert.deepEqual(values(db, 'SELECT * FROM delegation_budget_settings'), [[1, 3, 300_000, 10, 30, 30, 90, 600_000]]);
  assert.deepEqual(values(telegram, 'SELECT * FROM session_ownership'),
    [['topic-session', 'main', 'legacy-default', 'channel', 'telegram-main', 'topic:0', 1]]);
  for (const [store, names] of [
    [db, ['agents', 'agent_workspaces', 'workspace_read_folders', 'agent_knowledge_reads', 'agent_write_targets',
      'agent_capabilities', 'workspace_mcp_grants', 'agent_trigger_settings', 'session_ownership',
      'file_classifications', 'delegation_budget_settings', 'channel_accounts', 'telegram_account_settings', 'delegation_budget_choice']],
    [telegram, ['session_ownership']], [knowledge, ['vault_classifications', 'bi_job_ownership', 'review_provenance', 'bi_publication_ownership']],
  ] as const) {
    for (const name of names) {
      assert.equal(store.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(name)?.strict, 1, name);
    }
  }
  for (const id of ['main', 'bi']) {
    assert.throws(() => db.prepare('DELETE FROM agents WHERE id=?').run(id), /cannot be deleted/);
    assert.throws(() => db.prepare("UPDATE agents SET id='replacement' WHERE id=?").run(id), /identity is fixed/);
    assert.throws(() => db.prepare('UPDATE agents SET builtin_key=NULL WHERE id=?').run(id), /identity is fixed/);
    assert.throws(() => db.prepare("UPDATE agents SET state='archived' WHERE id=?").run(id), /CHECK constraint/);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO agents SELECT * FROM agents WHERE id=?').run(id), /cannot be replaced/);
  }
  const insertAgent = db.prepare("INSERT INTO agents VALUES (?, ?, ?, 'active', '', '', '', NULL, NULL, NULL, 'en', 1, 0, 0)");
  assert.throws(() => insertAgent.run('second-main', 'orchestrator', null), /CHECK constraint/);
  assert.throws(() => insertAgent.run('second-bi', 'specialist', 'bi'), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE agents SET role='orchestrator' WHERE id='bi'"), /identity is fixed/);
  assert.throws(() => db.exec("UPDATE agents SET config_revision='not an integer' WHERE id='main'"), /cannot store TEXT/);
  assert.throws(() => db.exec("UPDATE agents SET avatar=X'10' WHERE id='main'"), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE agents SET avatar=zeroblob(92161), avatar_mime='image/png' WHERE id='main'"), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE agents SET name=printf('%081d', 0) WHERE id='main'"), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE agents SET reply_locale='fr' WHERE id='main'"), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE agent_workspaces SET is_default=1 WHERE id='legacy-secondary'"), /UNIQUE constraint/);
  assert.throws(() => db.exec("UPDATE agent_workspaces SET classification='internal' WHERE id='bi'"), /CHECK constraint/);
  assert.throws(() => db.exec("INSERT INTO file_classifications VALUES ('run', 'file', 'bi', 'hash', 'public', 0)"), /CHECK constraint/);
  assert.throws(() => db.exec("INSERT INTO file_classifications VALUES ('artifact', 'file', 'bi', 'hash', 'private', 0)"), /CHECK constraint/);
  db.exec("INSERT INTO file_classifications(file_kind, file_id, workspace_id, sha256, updated_at) VALUES ('artifact', 'file', 'bi', 'hash', 0)");
  assert.deepEqual(values(db, 'SELECT classification FROM file_classifications'), [['unclassified']]);
  assert.throws(() => knowledge.exec("INSERT INTO vault_classifications VALUES ('missing', 'internal', 0)"), /CHECK constraint/);
  assert.throws(() => knowledge.exec("INSERT INTO vault_classifications VALUES ('missing', 'public', 0)"), /FOREIGN KEY constraint/);
  assert.throws(() => db.exec('UPDATE delegation_budget_settings SET queue_ms=0'), /CHECK constraint/);
  db.exec('UPDATE delegation_budget_settings SET queue_ms=123456');
  assert.equal(db.prepare('SELECT queue_ms FROM delegation_budget_settings').get()?.queue_ms, 123456);
  insertAgent.run('ordinary', 'specialist', null);
  db.exec(`
    INSERT INTO agent_workspaces(id, agent_id, layout, relative_root, is_default, created_at)
      VALUES ('ordinary-workspace', 'ordinary', 'managed', 'web/agents/ordinary', 1, 0);
    INSERT INTO web_sessions VALUES ('history', 'upstream', 'inspector', 'synthetic', 0);
    INSERT INTO session_ownership VALUES ('history', 'ordinary', 'ordinary-workspace', 'web', NULL, NULL, NULL);
    INSERT INTO runs VALUES ('ordinary-run', 'accepted', '{}');
    INSERT INTO web_turns VALUES ('history', 'ordinary-run', 'synthetic');
  `);
  assert.throws(() => db.exec("UPDATE agents SET state='archived' WHERE id='ordinary'"), /open runs/);
  db.exec(`
    UPDATE runs SET state='failed' WHERE id='ordinary-run';
    UPDATE agents SET state='archived' WHERE id='ordinary';
  `);
  assert.deepEqual(values(db, "SELECT state FROM agents WHERE id='ordinary'"), [['archived']]);
  assert.deepEqual(values(db, 'SELECT session_id FROM session_ownership'), [['history']]);
  assert.throws(() => db.exec("DELETE FROM agents WHERE id='ordinary'"), /FOREIGN KEY constraint/);
  assert.throws(() => db.exec("UPDATE session_ownership SET workspace_id='legacy-default'"), /FOREIGN KEY constraint/);
  assert.throws(() => db.exec("UPDATE session_ownership SET origin='channel'"), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE session_ownership SET binding_revision=1"), /CHECK constraint/);
});

test('legacy settings and sessions continue to write through the same APIs', (t) => {
  const root = directory(t);
  const { web } = seedPhase3bFixture(root);
  const path = join(web, 'web.sqlite');
  const store = new WebStore(path);
  try {
    assert.deepEqual(store.sessions().map((session) => [session.id, session.project]), [['visible', 'default']]);
    store.createSession({ id: 'new-secondary', upstreamID: 'new-upstream', agent: 'inspector', alias: 'synthetic', createdAt: 9, project: 'secondary' });
    store.savePreferences('Updated', 'Introduction', 'Instructions');
    store.saveAppearance('system', 'comfortable', null);
    store.addProjectFolder('secondary', join(root, 'added'));
    assert.ok(store.removeProjectFolder('default', join(root, 'external-default')));
    assert.ok(store.removeCustomMcp(fixtureMcpId));
    assert.equal(store.removeCustomMcp(fixtureMcpId), false);
  } finally { store.close(); }
  using db = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(values(db, "SELECT name, avatar, config_revision FROM agents WHERE id='main'"), [['Updated', null, 3]]);
  assert.deepEqual(values(db, 'SELECT * FROM workspace_read_folders ORDER BY folder'),
    [['legacy-secondary', join(root, 'added')], ['legacy-secondary', join(root, 'external-secondary')]]);
  assert.deepEqual(values(db, 'SELECT * FROM agent_capabilities'), []);
  assert.deepEqual(values(db, 'SELECT * FROM workspace_mcp_grants'), []);
  assert.deepEqual(values(db, "SELECT workspace_id FROM session_ownership WHERE session_id='new-secondary'"), [['legacy-secondary']]);
});

test('migration skips inactive knowledge and a configured BI target without an active publication', (t) => {
  const root = directory(t);
  const { web } = seedPhase3bFixture(root);
  {
    using knowledge = new DatabaseSync(join(web, 'knowledge.sqlite'));
    knowledge.exec("INSERT INTO inactive_vaults VALUES ('synthetic-bench')");
  }
  migrate(root);
  using db = new DatabaseSync(join(web, 'web.sqlite'), { readOnly: true });
  assert.deepEqual(values(db, 'SELECT * FROM agent_knowledge_reads'), []);
  assert.deepEqual(values(db, 'SELECT * FROM agent_write_targets'), []);
});

test('a failed slice migration rolls back each owned DB and resumes earlier commits on retry', (t) => {
  const root = directory(t);
  const { web } = seedPhase3bFixture(root);
  const open = (name: string) => new DatabaseSync(join(web, name + '.sqlite'));
  {
    using db = open('web');
    db.exec('CREATE TABLE delegation_budget_settings (id INTEGER)');
    migrate(root, /【web\/web.sqlite】.*套用 SQLite 結構遷移失敗/);
    assert.equal(version(db), 2);
    assert.equal(table(db, 'agents'), undefined);
    assert.equal(db.prepare('SELECT count(*) AS total FROM web_sessions').get()?.total, 2);
    db.exec('DROP TABLE delegation_budget_settings');
  }
  {
    using db = open('telegram-chat');
    db.exec("INSERT INTO web_session_project VALUES ('telegram-session', 'unknown')");
    migrate(root, /【web\/telegram-chat.sqlite】.*套用 SQLite 結構遷移失敗/);
    assert.equal(version(db), 2);
    assert.equal(table(db, 'session_ownership'), undefined);
    using central = open('web');
    assert.equal(version(central), 9);
    assert.deepEqual(values(central, 'SELECT id FROM agents ORDER BY id'), [['bi'], ['main']]);
    db.exec("DELETE FROM web_session_project WHERE id='telegram-session'");
  }
  {
    using db = open('knowledge');
    db.exec('DROP TABLE benchmark_sets; CREATE TABLE vault_classifications (id INTEGER)');
    migrate(root, /【web\/knowledge.sqlite】.*套用 SQLite 結構遷移失敗/);
    assert.equal(version(db), 1);
    assert.equal(table(db, 'benchmark_sets'), undefined);
    assert.deepEqual(values(db, "SELECT status FROM reviews WHERE id='pending-bi'"), [['pending']]);
    assert.deepEqual(values(db, "SELECT status FROM reviews WHERE id='manual-bi'"), [['approved']]);
    using telegram = open('telegram-chat');
    assert.equal(version(telegram), 3);
    db.exec('DROP TABLE vault_classifications');
  }
  {
    using db = open('knowledge');
    db.exec('CREATE TABLE review_provenance (id INTEGER)');
    migrate(root, /【web\/knowledge.sqlite】.*套用 SQLite 結構遷移失敗/);
    assert.equal(version(db), 1);
    assert.equal(table(db, 'bi_job_ownership'), undefined);
    assert.equal(table(db, 'vault_classifications'), undefined);
    db.exec('DROP TABLE review_provenance');
  }
  migrate(root);
  using db = open('knowledge');
  assert.equal(version(db), 3);
  assert.ok(table(db, 'benchmark_sets'));
  assert.ok(table(db, 'vault_classifications'));
  const paths = ['web', 'telegram-chat', 'knowledge', 'telegram'];
  assert.deepEqual(paths.map((name) => {
    using db = open(name);
    return version(db);
  }), [9, 3, 3, 2]);
});

test('opening a current session ledger rejects absent owners and invalid central references', (t) => {
  const root = directory(t);
  const { web } = seedPhase3bFixture(root);
  migrate(root);
  const file = join(web, 'telegram-chat.sqlite');
  {
    using chat = new DatabaseSync(file);
    chat.exec("UPDATE session_ownership SET workspace_id='bi' WHERE session_id='telegram-session'");
  }
  assert.throws(() => new WebStore(file), /Telegram session workspace ownership is invalid/);
  const central = join(web, 'web.sqlite');
  {
    using db = new DatabaseSync(central);
    db.exec("DELETE FROM session_ownership WHERE session_id='hidden'");
  }
  assert.throws(() => new WebStore(central), /Session ownership is missing/);
});
