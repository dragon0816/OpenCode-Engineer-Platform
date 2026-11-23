import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, lstatSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { legacyAgentRows, verifyAgentLedger } from '../../apps/adapter/src/runs/agent-ledger.ts';
import { verifyWorkItems } from '../../apps/adapter/src/runs/work-items.ts';
import { verifyDelegations } from '../../apps/adapter/src/runs/delegation-schema.ts';
import { verifyExternalHelpers } from '../../apps/adapter/src/runs/external-schema.ts';
import { legacyAllowlistRef, legacyChannelAccounts, legacyChannels, telegramCredentialRef } from '../../apps/adapter/src/channels/accounts.ts';
import { legacyChannelRows, legacyTelegramTables, migratedChannelTables, telegramInboxVersion, verifyChannelConversations }
  from '../../apps/adapter/src/telegram/channel-migration.ts';
import { openBiReviewStore, verifyBiSourceOwners, verifyBiSourceReceipts } from '../../apps/adapter/src/bi/source-ownership.ts';
import { biOwnershipTables, legacyBiOwnership, openBiChannelStore, verifyBiOwnership } from '../../packages/knowledge/src/bi/ownership.ts';
import { dataMigrations } from './data-migrations.ts';
import { diagnosticPath, isOepDatabase } from './snapshot-paths.mjs';

const [mode, root, destination] = process.argv.slice(2);
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const localName = (path) => relative(root, path).split(sep).join('/') || '.';
class SnapshotError extends Error {
  constructor(path, check) {
    super(`【${diagnosticPath(path)}】${check}`);
  }
}

async function check(path, description, operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(path, description);
  }
}

async function credentials() {
  const folder = join(root, 'web');
  const path = join(folder, 'web.sqlite');
  const directory = lstatSync(folder, { throwIfNoEntry: false });
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error('Invalid web directory');
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return [];
  if (!file.isFile()) throw new Error('Invalid web database');
  return useDatabase(path, (db) => {
    const names = new Set();
    const hasTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
    const legacyRefs = new Set(legacyChannels.map(({ credentialRef }) => credentialRef));
    if (hasTable.get('channel_accounts')) {
      for (const { credential_ref, allowlist_ref } of db.prepare("SELECT credential_ref, allowlist_ref FROM channel_accounts WHERE provider='telegram'").iterate()) {
        if (!telegramCredentialRef.test(credential_ref) || allowlist_ref !== legacyAllowlistRef) {
          throw new Error('Invalid Telegram credential reference');
        }
        if (!legacyRefs.has(credential_ref)) names.add(credential_ref);
      }
    }
    const mcp = hasTable.get('mcp_servers') ? db.prepare('SELECT id, definition FROM mcp_servers').iterate() : [];
    for (const { id, definition } of mcp) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid MCP identifier');
      const { transport, environment } = JSON.parse(definition);
      const remote = transport === 'remote';
      for (const { name, reference } of environment) {
        const valid = remote ? /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
        const suffix = remote ? name.toUpperCase().replaceAll('-', '_') : name.toUpperCase();
        if (!valid.test(name) ||
            reference !== 'OEP_MCP_' + id.toUpperCase() + '_' + suffix) {
          throw new Error('Invalid MCP credential reference');
        }
        names.add(reference);
      }
    }
    return [...names].sort();
  });
}

function* files(directory) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { throw new SnapshotError(localName(directory), '無法列出資料目錄。'); }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new SnapshotError(localName(path), '資料路徑含有連結。');
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
    else throw new SnapshotError(localName(path), '資料項目非一般檔案或目錄。');
  }
}

function useDatabase(path, operation) {
  const db = new DatabaseSync(path, { readOnly: true });
  return Promise.resolve().then(() => operation(db)).finally(() => db.close());
}

function excluded(name) {
  const parts = name.split('/');
  return parts[0] === 'maintenance.log' || parts[0] === 'backup.manifest.json' ||
    (parts[0] === 'web' && (/^launch-/.test(parts[1]) || /^open-.*\.request$/.test(parts[1]))) ||
    basename(name).toLowerCase() === 'auth.json';
}

async function snapshot() {
  const candidates = new Set([...files(root)].map(localName));
  for (const name of candidates) {
    if (excluded(name)) continue;
    const base = name.replace(/-(?:wal|shm|journal)$/, '');
    if (base !== name && isOepDatabase(base) && candidates.has(base)) continue;
    const path = join(root, name);
    const output = join(destination, name);
    const sqlite = isOepDatabase(name);
    await check(name, sqlite ? 'SQLite 線上備份失敗。' : '複製檔案失敗。', async () => {
      mkdirSync(join(output, '..'), { recursive: true });
      if (sqlite) {
        await useDatabase(path, (db) => backup(db, output, { rate: 128 }));
        const db = new DatabaseSync(output);
        try { db.exec('PRAGMA journal_mode = DELETE'); } finally { db.close(); }
      } else copyFileSync(path, output);
    });
  }
}

async function describe({ live = false } = {}) {
  const databases = {};
  const inventory = [];
  for (const path of [...files(root)].sort()) {
    const name = localName(path);
    if (live && excluded(name)) continue;
    if (name === 'backup.manifest.json') continue;
    const bytes = await check(name, '讀取檔案以計算 SHA-256 失敗。', () => readFileSync(path));
    inventory.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (!isOepDatabase(name)) continue;
    databases[name] = await check(name, 'SQLite 結構、筆數或發布修訂讀取失敗。', () => useDatabase(path, (db) => {
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') {
        throw new SnapshotError(name, 'SQLite quick_check 完整性檢查失敗。');
      }
      const counts = {};
      for (const { name: table } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()) {
        counts[table] = db.prepare('SELECT count(*) AS total FROM ' + quote(table)).get().total;
      }
      const publicationFields = counts.publications === undefined ? [] : db.prepare('PRAGMA table_info(publications)').all().map((column) => column.name);
      const revisions = publicationFields.includes('manifest_hash') ? db.prepare(
        'SELECT vault, revision, manifest_hash, input_hash, index_hash FROM publications ORDER BY vault, revision'
      ).all() : [];
      const publicationCounts = {};
      if (revisions.length) {
        const blob = db.prepare('SELECT bytes FROM blobs WHERE hash = ?');
        for (const revision of revisions) {
          const document = JSON.parse(Buffer.from(blob.get(revision.manifest_hash).bytes).toString('utf8'));
          publicationCounts[revision.manifest_hash] = {
            cards: document.cards.length,
            passages: document.passages.length,
            evidence: document.repository?.evidence?.length ?? 0,
            relations: document.relationships.length,
          };
        }
      }
      return { userVersion: db.prepare('PRAGMA user_version').get().user_version, counts, revisions, publicationCounts };
    }));
  }
  return { inventory, databases };
}

function digestRow(values) {
  return createHash('sha256').update(JSON.stringify(values.map((value) =>
    typeof value === 'bigint' ? ['integer', String(value)] :
      value instanceof Uint8Array ? ['blob', Buffer.from(value).toString('base64')] : value))).digest('hex');
}

function rowDigests(db, table, columns, ordered = false) {
  const statement = db.prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(table) + (ordered ? ' ORDER BY rowid' : ''));
  statement.setReadBigInts(true);
  const hashes = [...statement.iterate()].map((row) => digestRow(Object.values(row)));
  return ordered ? hashes : hashes.sort();
}

const columnsOf = (db, table) => db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
  .all(table).map(({ name }) => name);

// These stores create empty tables on first open when upgrading an older schema.
const webAdditions = new Set([
  'web_session_display', 'web_session_project', 'web_preferences', 'web_settings_audit',
  'web_turn_limits', 'web_model_settings', 'web_project_folders', 'web_action_decisions',
  'web_message_annotations', 'web_turn_replies', 'web_session_knowledge_disabled',
  'web_knowledge_settings', 'web_appearance', 'web_sessions', 'attachments', 'web_turns', 'mcp_servers',
  'web_model_catalog', 'web_model_selection',
]);
const knowledgeAdditions = new Set([
  'benchmark_sets', 'inactive_vaults', 'review_uploads', 'review_schemas', 'review_schema_heads',
  'reviews', 'review_edits', 'notification_intents', 'ingest_jobs', 'ingest_effects',
]);
const webV3Empty = new Set(['file_classifications']);
const webV5Empty = new Set(['agent_work_items']);
const webV6Empty = new Set(['delegations', 'delegation_events', 'delegation_request_keys', 'delegation_files', 'delegation_notices']);
const webV7Empty = new Set(['external_helper_settings', 'external_sources', 'external_snapshots', 'external_confirmations']);
const knowledgeV2Empty = new Set(['vault_classifications']);
const emptyTables = new Set();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function backupManifest(path) {
  return check('backup.manifest.json', '備份清單讀取或 JSON 結構檢查失敗。', () => {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(manifest?.inventory) || !manifest.databases ||
        typeof manifest.databases !== 'object' || Array.isArray(manifest.databases)) {
      throw new Error('Invalid backup manifest');
    }
    return manifest;
  });
}

async function reconcileRestore() {
  const before = await backupManifest(destination);
  const after = await describe();
  const names = new Set([...Object.keys(before.databases).filter(isOepDatabase), ...Object.keys(after.databases)]);
  for (const name of names) {
    if (!same(before.databases[name], after.databases[name])) {
      throw new SnapshotError(name, '回復比對失敗。資料筆數、SQLite 版本或發布修訂雜湊不符。');
    }
  }
}

function verifyAgentSeeds(name, oldDb, newDb, counts, channel) {
  const expected = legacyAgentRows(oldDb, dirname(join(destination, name)), channel);
  for (const [table, rows] of Object.entries(expected)) verifySeedRows(name, newDb, counts, table, rows);
  return expected;
}

function verifyEmptyAdditions(name, counts, tables) {
  for (const table of tables) {
    if (counts[table] !== 0) throw new SnapshotError(name, `升級比對失敗。${table} 必須存在且初始為空。`);
  }
}

function verifyChannelSeeds(name, oldDb, newDb, counts) {
  using knowledge = openBiReviewStore(dirname(join(destination, name)));
  for (const table of migratedChannelTables) {
    const ordered = table === 'channel_inbound' || table === 'channel_outbound';
    verifySeedRows(name, newDb, counts, table, legacyChannelRows(oldDb, table, knowledge), ordered);
  }
}

const migratedRowDigest = (row) => digestRow(row.map((value) => typeof value === 'number' ? BigInt(value) : value));

function verifySeedRows(name, db, counts, table, rows, ordered = false) {
  const expected = Array.from(rows, migratedRowDigest);
  if (!ordered) expected.sort();
  if (counts[table] !== expected.length || !same(rowDigests(db, table, columnsOf(db, table), ordered), expected)) {
    throw new SnapshotError(name, `升級比對失敗。${table} 初始資料、歸屬或來源不符。`);
  }
}

function verifyChannelOwners(name, db) {
  const sessionsPath = join(root, dirname(name), 'telegram-chat.sqlite');
  using sessions = lstatSync(sessionsPath, { throwIfNoEntry: false })
    ? new DatabaseSync(sessionsPath, { readOnly: true }) : undefined;
  try { verifyChannelConversations(db, sessions); }
  catch { throw new SnapshotError(name, '升級比對失敗。channel_conversations 歸屬不符。'); }
}

async function verifyNewCentralStore(name, next, before) {
  const chat = name.replace(/web\.sqlite$/, 'telegram-chat.sqlite');
  if (name === chat || !name.endsWith('web.sqlite') || !Object.hasOwn(before, chat) ||
      next.userVersion !== dataMigrations['web.sqlite'].version) {
    throw new SnapshotError(name, '升級比對失敗。出現未預期的受管資料庫。');
  }
  await check(name, '升級比對失敗。無法驗證新建的中央工作台資料庫。', () => useDatabase(join(root, name), (db) => {
    const seeds = verifyAgentSeeds(name, undefined, db, next.counts, false);
    verifySeedRows(name, db, next.counts, 'channel_accounts', legacyChannelAccounts());
    const empty = new Set(['runs', 'run_events', ...webAdditions, ...webV3Empty, ...webV5Empty, ...webV6Empty, ...webV7Empty]);
    verifyEmptyAdditions(name, next.counts, empty);
    if (Object.keys(next.counts).some((table) => table !== 'channel_accounts' && !empty.has(table) && !Object.hasOwn(seeds, table))) {
      throw new SnapshotError(name, '升級比對失敗。新建的中央工作台資料庫包含未知資料表。');
    }
    verifyAgentLedger(db, join(root, name), false);
    verifyWorkItems(db);
    verifyDelegations(db);
    verifyExternalHelpers(db);
  }));
}

async function reconcileUpgrade() {
  const before = await backupManifest(join(destination, 'backup.manifest.json'));
  const after = await describe({ live: true });
  const inventory = new Map(after.inventory.map((file) => [file.path, file]));
  for (const file of before.inventory) {
    if ((!isOepDatabase(file.path) || !Object.hasOwn(before.databases, file.path)) && !same(inventory.get(file.path), file)) {
      throw new SnapshotError(file.path, '升級比對失敗。檔案大小或 SHA-256 不符。');
    }
  }
  for (const [name, next] of Object.entries(after.databases)) {
    if (!Object.hasOwn(before.databases, name)) await verifyNewCentralStore(name, next, before.databases);
  }
  for (const [name, prior] of Object.entries(before.databases)) {
    if (!isOepDatabase(name)) continue;
    const next = after.databases[name];
    if (!next || next.userVersion < prior.userVersion) {
      throw new SnapshotError(name, '升級比對失敗。缺少原資料庫或 SQLite user_version 倒退。');
    }
    if (!same(prior.revisions, next.revisions) || !same(prior.publicationCounts, next.publicationCounts)) {
      throw new SnapshotError(name, '升級比對失敗。發布修訂雜湊或修訂筆數不符。');
    }
    const file = basename(name).toLowerCase();
    const channel = file === 'telegram-chat.sqlite';
    const web = channel || file === 'web.sqlite';
    const knowledge = file === 'knowledge.sqlite';
    const telegram = file === 'telegram.sqlite';
    const migration = dataMigrations[file];
    if (migration && next.userVersion !== migration.version) {
      throw new SnapshotError(name, '升級比對失敗。SQLite user_version 與新版不符。');
    }
    const seedWeb = web && [0, 1, 2].includes(prior.userVersion) && next.userVersion >= 3;
    const seedAccounts = file === 'web.sqlite' && [0, 1, 2, 3].includes(prior.userVersion) && next.userVersion >= 4;
    const addWorkItems = file === 'web.sqlite' && [0, 1, 2, 3, 4].includes(prior.userVersion) && next.userVersion >= 5;
    const addDelegations = file === 'web.sqlite' && [0, 1, 2, 3, 4, 5].includes(prior.userVersion) && next.userVersion >= 6;
    const addExternalHelpers = file === 'web.sqlite' && [0, 1, 2, 3, 4, 5, 6].includes(prior.userVersion) && next.userVersion >= 7;
    const seedKnowledge = knowledge && [0, 1].includes(prior.userVersion) && next.userVersion >= 2;
    const seedBi = knowledge && [0, 1, 2].includes(prior.userVersion) && next.userVersion === 3;
    const seedTelegram = telegram && [0, 1].includes(prior.userVersion) && next.userVersion === 2;
    const expectedEmpty = seedWeb && !channel ? webV3Empty : seedKnowledge ? knowledgeV2Empty :
      seedTelegram ? new Set(legacyTelegramTables.filter((table) => !Object.hasOwn(prior.counts, table))) : emptyTables;
    const allowed = web ? webAdditions : knowledge ? knowledgeAdditions : emptyTables;
    await check(name, '升級比對失敗。無法讀取 SQLite 欄位或工作狀態。', () => useDatabase(join(destination, name), (oldDb) =>
      useDatabase(join(root, name), (newDb) => {
        const seeded = seedWeb ? verifyAgentSeeds(name, oldDb, newDb, next.counts, channel) : {};
        if (seedAccounts) verifySeedRows(name, newDb, next.counts, 'channel_accounts', legacyChannelAccounts());
        if (seedTelegram) verifyChannelSeeds(name, oldDb, newDb, next.counts);
        if (seedBi) {
          using spool = openBiChannelStore(dirname(join(destination, name)));
          for (const table of biOwnershipTables) verifySeedRows(name, newDb, next.counts, table, legacyBiOwnership(oldDb, spool, table));
        }
        verifyEmptyAdditions(name, next.counts, expectedEmpty);
        if (addWorkItems) verifyEmptyAdditions(name, next.counts, webV5Empty);
        if (addDelegations) verifyEmptyAdditions(name, next.counts, webV6Empty);
        if (addExternalHelpers) verifyEmptyAdditions(name, next.counts, webV7Empty);
        for (const [table, count] of Object.entries(next.counts)) {
          if (Object.hasOwn(prior.counts, table) || Object.hasOwn(seeded, table) ||
              seedAccounts && table === 'channel_accounts' ||
              seedBi && biOwnershipTables.includes(table) ||
              seedTelegram && migratedChannelTables.includes(table)) continue;
          if (count !== 0 || !allowed.has(table) && !expectedEmpty.has(table) &&
              !(addWorkItems && webV5Empty.has(table)) && !(addDelegations && webV6Empty.has(table)) &&
              !(addExternalHelpers && webV7Empty.has(table))) {
            throw new SnapshotError(name, '升級比對失敗。新增的資料表含有資料或未列入允許清單。');
          }
        }
        for (const [table, count] of Object.entries(prior.counts)) {
          if (next.counts[table] !== count) throw new SnapshotError(name, '升級比對失敗。既有資料表筆數不符。');
          const columns = columnsOf(oldDb, table);
          const newColumns = columnsOf(newDb, table);
          if (columns.some((column) => !newColumns.includes(column)) ||
              !same(rowDigests(oldDb, table, columns), rowDigests(newDb, table, columns))) {
            throw new SnapshotError(name, '升級比對失敗。既有欄位、資料列或工作狀態不符。');
          }
        }
        if ((web || knowledge || telegram) && newDb.prepare('PRAGMA foreign_key_check').get()) {
          throw new SnapshotError(name, '升級比對失敗。SQLite foreign_key_check 外鍵檢查失敗。');
        }
        if (web) verifyAgentLedger(newDb, join(root, name), channel);
        if (file === 'web.sqlite') {
          verifyWorkItems(newDb);
          verifyDelegations(newDb);
          verifyExternalHelpers(newDb);
        }
        if (knowledge && next.userVersion === 3) verifyBiOwnership(newDb);
        if (telegram && next.userVersion === telegramInboxVersion) {
          verifyChannelOwners(name, newDb);
          verifyBiSourceOwners(newDb);
          using reviews = openBiReviewStore(dirname(join(root, name)));
          verifyBiSourceReceipts(newDb, reviews);
        }
      })));
  }
}

async function intentDiff(report) {
  const before = await backupManifest(join(destination, 'backup.manifest.json'));
  const live = await describe({ live: true });
  const changes = [];
  for (const [database, metadata] of Object.entries(live.databases)) {
    await check(database, '回退時讀取待處理工作或計算雜湊失敗。', () => useDatabase(join(root, database), async (db) => {
      for (const table of ['notification_intents', 'outbox', 'inbox', 'channel_outbound', 'channel_inbound', 'agent_work_items',
        ...webV6Empty, ...webV7Empty, 'bi_jobs', 'ingest_jobs']) {
        if (!(table in metadata.counts)) continue;
        const metadataBefore = before.databases[database];
        const columns = columnsOf(db, table);
        const previous = metadataBefore?.counts[table] !== undefined
          ? await useDatabase(join(destination, database), (old) => {
            const columns = columnsOf(old, table);
            return { columns, digests: new Set(rowDigests(old, table, columns)) };
          }) : { columns, digests: new Set() };
        if (metadataBefore && metadataBefore.userVersion < 2 && migratedChannelTables.includes(table)) {
          await useDatabase(join(destination, database), (old) => {
            for (const row of legacyChannelRows(old, table)) {
              previous.digests.add(migratedRowDigest(row));
            }
          });
        }
        const addedOrChanged = rowDigests(db, table, previous.columns).filter((hash) => !previous.digests.has(hash));
        if (addedOrChanged.length) changes.push({ database, table, columns: previous.columns, addedOrChanged });
      }
    }));
  }
  await check('rollback-*.json', '寫入待處理工作比對報告失敗。', () => writeFileSync(report, JSON.stringify({ changes })));
}

try {
  if (mode === 'copy') await snapshot();
  else if (mode === 'describe') {
    const report = await describe();
    await check('.', '寫入快照清單失敗。', () => writeFileSync(destination, JSON.stringify(report), { flag: 'wx' }));
  } else if (mode === 'credentials') {
    const names = await check('web/web.sqlite', '讀取 MCP 憑證名稱失敗。', credentials);
    await check('web/web.sqlite', '寫入憑證名稱清單失敗。', () => writeFileSync(destination, JSON.stringify(names), { flag: 'wx' }));
  } else if (mode === 'reconcile-restore') await reconcileRestore();
  else if (mode === 'reconcile-upgrade') await reconcileUpgrade();
  else if (mode === 'intent-diff') await intentDiff(process.argv[5]);
  else throw new SnapshotError('scripts/windows/data-snapshot.mjs', '快照作業參數無效。');
} catch (error) {
  console.error(error instanceof SnapshotError ? error.message : '【.】SQLite 快照或資料比對失敗。');
  process.exitCode = 1;
}
