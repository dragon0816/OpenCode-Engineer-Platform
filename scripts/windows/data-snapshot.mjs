import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const [mode, root, destination] = process.argv.slice(2);
const header = Buffer.from('SQLite format 3\0');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked data');
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
    else throw new Error('Unsupported data');
  }
}

function sqlite(path) {
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(16);
    return readSync(descriptor, bytes, 0, 16, 0) === 16 && bytes.equals(header);
  } finally { closeSync(descriptor); }
}

function useDatabase(path, operation) {
  const db = new DatabaseSync(path, { readOnly: true });
  return Promise.resolve().then(() => operation(db)).finally(() => db.close());
}

function excluded(name) {
  const parts = name.split(sep);
  return parts[0] === 'maintenance.log' || parts[0] === 'backup.manifest.json' ||
    (parts[0] === 'web' && (/^launch-/.test(parts[1]) || /^open-.*\.request$/.test(parts[1]))) ||
    basename(name).toLowerCase() === 'auth.json';
}

async function snapshot() {
  const candidates = [...files(root)];
  for (const path of candidates) {
    const name = relative(root, path);
    if (excluded(name)) continue;
    const sidecar = /-(?:wal|shm|journal)$/.exec(path);
    if (sidecar && candidates.includes(path.slice(0, sidecar.index)) && sqlite(path.slice(0, sidecar.index))) continue;
    const output = join(destination, name);
    mkdirSync(join(output, '..'), { recursive: true });
    if (sqlite(path)) {
      await useDatabase(path, (db) => backup(db, output, { rate: 128 }));
      const db = new DatabaseSync(output);
      try { db.exec('PRAGMA journal_mode = DELETE'); } finally { db.close(); }
    } else copyFileSync(path, output);
  }
}

async function describe({ live = false } = {}) {
  const databases = {};
  const inventory = [];
  for (const path of [...files(root)].sort()) {
    const local = relative(root, path);
    if (live && excluded(local)) continue;
    const name = local.split(sep).join('/');
    if (name === 'backup.manifest.json') continue;
    const bytes = readFileSync(path);
    inventory.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (!bytes.subarray(0, 16).equals(header)) continue;
    databases[name] = await useDatabase(path, (db) => {
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity');
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
    });
  }
  return { inventory, databases };
}

function rowDigests(db, table, columns) {
  const statement = db.prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(table));
  statement.setReadBigInts(true);
  return [...statement.iterate()].map((row) => createHash('sha256').update(JSON.stringify(
    Object.values(row).map((value) => typeof value === 'bigint' ? ['integer', String(value)] :
      value instanceof Uint8Array ? ['blob', Buffer.from(value).toString('base64')] : value),
  )).digest('hex')).sort();
}

const columnsOf = (db, table) => db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
  .all(table).map(({ name }) => name);

// These stores create empty tables on first open when upgrading an older schema.
const webAdditions = new Set([
  'web_session_display', 'web_session_project', 'web_preferences', 'web_settings_audit',
  'web_turn_limits', 'web_model_settings', 'web_project_folders', 'web_action_decisions',
  'web_message_annotations', 'web_turn_replies', 'web_session_knowledge_disabled',
  'web_knowledge_settings', 'web_appearance', 'web_sessions', 'attachments', 'web_turns',
]);
const knowledgeAdditions = new Set([
  'benchmark_sets', 'inactive_vaults', 'review_uploads', 'review_schemas', 'review_schema_heads',
  'reviews', 'review_edits', 'notification_intents', 'ingest_jobs', 'ingest_effects',
]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function reconcileUpgrade() {
  const before = JSON.parse(readFileSync(join(destination, 'backup.manifest.json'), 'utf8'));
  const after = await describe({ live: true });
  for (const file of before.inventory) {
    if (!before.databases[file.path] && !after.inventory.some((entry) => same(entry, file))) {
      throw new Error('File changed');
    }
  }
  for (const [name, prior] of Object.entries(before.databases)) {
    const next = after.databases[name];
    if (!next || next.userVersion < prior.userVersion || !same(prior.revisions, next.revisions) ||
        !same(prior.publicationCounts, next.publicationCounts)) throw new Error('Database changed');
    const allowed = /(?:^|\/)(web|telegram-chat)\.sqlite$/.test(name) ? webAdditions :
      basename(name) === 'knowledge.sqlite' ? knowledgeAdditions : new Set();
    for (const [table, count] of Object.entries(next.counts)) {
      if (!(table in prior.counts) && (count !== 0 || !allowed.has(table))) throw new Error('Unexpected new table');
    }
    await useDatabase(join(destination, name), (oldDb) =>
      useDatabase(join(root, name), (newDb) => {
        for (const [table, count] of Object.entries(prior.counts)) {
          if (next.counts[table] !== count) throw new Error('Row count changed');
          const columns = columnsOf(oldDb, table);
          const newColumns = columnsOf(newDb, table);
          if (columns.some((column) => !newColumns.includes(column)) ||
              !same(rowDigests(oldDb, table, columns), rowDigests(newDb, table, columns))) {
            throw new Error('Rows changed');
          }
        }
      }));
  }
}

async function intentDiff(report) {
  const before = JSON.parse(readFileSync(join(destination, 'backup.manifest.json'), 'utf8'));
  const live = await describe({ live: true });
  const changes = [];
  for (const [database, metadata] of Object.entries(live.databases)) {
    await useDatabase(join(root, database), async (db) => {
      for (const table of ['notification_intents', 'outbox', 'inbox', 'bi_jobs', 'ingest_jobs']) {
        if (!(table in metadata.counts)) continue;
        const previous = before.databases[database]?.counts[table] !== undefined
          ? await useDatabase(join(destination, database), (old) => {
            const columns = columnsOf(old, table);
            return { columns, digests: new Set(rowDigests(old, table, columns)) };
          }) : { columns: columnsOf(db, table), digests: new Set() };
        const addedOrChanged = rowDigests(db, table, previous.columns).filter((hash) => !previous.digests.has(hash));
        if (addedOrChanged.length) changes.push({ database, table, columns: previous.columns, addedOrChanged });
      }
    });
  }
  writeFileSync(report, JSON.stringify({ changes }));
}

try {
  if (mode === 'copy') await snapshot();
  else if (mode === 'describe') writeFileSync(destination, JSON.stringify(await describe()), { flag: 'wx' });
  else if (mode === 'reconcile-upgrade') await reconcileUpgrade();
  else if (mode === 'intent-diff') await intentDiff(process.argv[5]);
  else throw new Error('Unknown mode');
} catch {
  process.exitCode = 1;
}
