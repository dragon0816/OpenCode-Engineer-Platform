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

async function snapshot() {
  const candidates = [...files(root)];
  for (const path of candidates) {
    const name = relative(root, path);
    const parts = name.split(sep);
    if (parts[0] === 'maintenance.log' || parts[0] === 'backup.manifest.json' ||
      (parts[0] === 'web' && (/^launch-/.test(parts[1]) || /^open-.*\.request$/.test(parts[1])))) continue;
    if (basename(path).toLowerCase() === 'auth.json') continue;
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

async function describe() {
  const databases = {};
  const inventory = [];
  for (const path of [...files(root)].sort()) {
    const name = relative(root, path).split(sep).join('/');
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

try {
  if (mode === 'copy') await snapshot();
  else if (mode === 'describe') writeFileSync(destination, JSON.stringify(await describe()), { flag: 'wx' });
  else throw new Error('Unknown mode');
} catch {
  process.exitCode = 1;
}
