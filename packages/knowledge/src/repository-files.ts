import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { sha256 } from './snapshot.ts';

export const maxRecordBytes = 2 * 1024 * 1024;
const maxDatabaseBytes = 128 * 1024 * 1024;
export const sqliteExtension = (name: string) => /\.(?:sqlite3?|db)$/i.test(name);
const comparePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export class RepositoryError extends Error {
  file: string;
  constructor(file: string, message: string) {
    super(message);
    this.file = file;
  }
}

function fileError(file: string, error: unknown): RepositoryError {
  if (error instanceof RepositoryError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new RepositoryError(file, code === 'ENOENT' ? 'File is missing or has not synced.' :
    'Cannot read file or folder. Check local sync and permissions.');
}

function safeRelative(name: string) {
  return name.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !/[\\:\u0000-\u001f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function isLocalAbsoluteFolder(path: string) {
  return isAbsolute(path) && !/[\u0000-\u001f]/.test(path) && (process.platform === 'win32'
    ? /^[a-z]:[\\/][^:]*$/i.test(path)
    : !path.startsWith('//'));
}

export class RepositoryFolder {
  root: string;
  constructor(folder: string) {
    this.root = resolve(folder);
    if (!folder || !isLocalAbsoluteFolder(this.root)) throw new RepositoryError('.', 'Provide a local repository folder.');
    try {
      if (!lstatSync(this.root).isDirectory() || !comparePath(realpathSync.native(this.root), this.root)) {
        throw new RepositoryError('.', 'Repository folder is unsafe or linked.');
      }
    } catch (error) { throw fileError('.', error); }
  }

  contains(path: string) {
    const child = relative(this.root, resolve(path));
    return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
  }

  private path(file: string) {
    if (file === '.') return this.root;
    if (!safeRelative(file)) throw new RepositoryError(file, 'Unsafe repository path.');
    return join(this.root, ...file.split('/'));
  }

  private stat(file: string) {
    const path = this.path(file);
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !comparePath(realpathSync.native(path), path)) {
      throw new RepositoryError(file, 'Linked files and folders are skipped.');
    }
    return stat;
  }

  list(folder: string, optional = false) {
    try {
      if (!this.stat(folder).isDirectory()) throw new RepositoryError(folder, 'Expected a repository folder.');
      return readdirSync(this.path(folder), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw fileError(folder, error);
    }
  }

  private bytes(file: string, limit: number) {
    const before = this.stat(file);
    if (!before.isFile()) throw new RepositoryError(file, 'Expected a regular file.');
    if (before.size === 0n) throw new RepositoryError(file, 'File is empty or has not synced.');
    if (before.size > limit) throw new RepositoryError(file, 'File exceeds the read limit.');
    const fd = openSync(this.path(file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const same = (stat: typeof before) => stat.isFile() && before.ino === stat.ino && before.dev === stat.dev &&
        before.mtimeNs === stat.mtimeNs && before.ctimeNs === stat.ctimeNs && before.size === stat.size;
      const changed = () => new RepositoryError(file, 'File changed during read. Retry after sync.');
      if (!same(fstatSync(fd, { bigint: true }))) throw changed();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!read) throw changed();
        offset += read;
      }
      if (!same(fstatSync(fd, { bigint: true })) || !same(this.stat(file))) throw changed();
      return bytes;
    } finally { closeSync(fd); }
  }

  json(file: string) {
    try {
      const json: unknown = JSON.parse(this.utf8(file));
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SyntaxError();
      return json as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new RepositoryError(file, 'Invalid UTF-8 JSON record.');
      }
      throw fileError(file, error);
    }
  }

  utf8(file: string, limit = maxRecordBytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(file, limit)); }
    catch (error) {
      if (error instanceof TypeError) throw new RepositoryError(file, 'Invalid UTF-8 record.');
      throw fileError(file, error);
    }
  }

  private sqliteBytes(file: string) {
    for (const suffix of ['-wal', '-journal']) {
      try {
        if (lstatSync(this.path(file + suffix)).size > 0) {
          throw new RepositoryError(file, 'SQLite snapshot has a nonempty journal or WAL sidecar.');
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this.bytes(file, maxDatabaseBytes);
  }

  sqlite<T>(file: string, read: (db: DatabaseSync, bytes: Buffer, digest: string) => T,
    verify?: (bytes: number, digest: string) => void) {
    try {
      const bytes = this.sqliteBytes(file);
      if (!bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
        throw new RepositoryError(file, 'Invalid SQLite header.');
      }
      const digest = sha256(bytes);
      verify?.(bytes.length, digest);
      const uri = pathToFileURL(this.path(file));
      uri.search = '?mode=ro&immutable=1';
      const db = new DatabaseSync(uri.href, { readOnly: true, allowExtension: false });
      try {
        db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
        if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') {
          throw new RepositoryError(file, 'SQLite integrity check failed.');
        }
        const result = read(db, bytes, digest);
        if (digest !== sha256(this.sqliteBytes(file))) throw new RepositoryError(file, 'SQLite changed during read. Retry after sync.');
        return result;
      } finally { db.close(); }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (String((error as NodeJS.ErrnoException)?.code).includes('SQLITE')) {
        throw new RepositoryError(file, 'Cannot read SQLite snapshot or its schema.');
      }
      throw fileError(file, error);
    }
  }

  inventory() {
    const folders: Array<{ folder: string; extensions: Record<string, number> }> = [];
    const databases: Array<{ path: string; bytes?: number }> = [];
    const errors: RepositoryError[] = [];
    const root = { folder: '.', extensions: {} };
    let remaining = 50_000;
    const visit = (folder: string, depth: number, totals: Record<string, number>) => {
      if (remaining < 0) return;
      try {
        if (depth > 32) throw new RepositoryError(folder, 'Folder nesting exceeds the inspection limit.');
        for (const entry of this.list(folder)) {
          if (--remaining < 0) throw new RepositoryError('.', 'Folder exceeds the inspection entry limit.');
          const path = folder === '.' ? entry.name : `${folder}/${entry.name}`;
          if (entry.isDirectory()) {
            const counts = depth ? totals : {};
            if (!depth) folders.push({ folder: entry.name, extensions: counts });
            visit(path, depth + 1, counts);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            const bucket = /^\.[a-z\d]{1,16}$/.test(ext) ? ext : ext ? '(other)' : '(none)';
            totals[bucket] = (totals[bucket] ?? 0) + 1;
            if (sqliteExtension(path)) {
              let bytes: number | undefined;
              try { bytes = lstatSync(this.path(path)).size; }
              catch { /* The SQLite read reports the file if it remains unavailable. */ }
              databases.push({ path, bytes });
            }
          } else if (entry.isSymbolicLink()) errors.push(new RepositoryError(path, 'Linked files and folders are skipped.'));
        }
      } catch (error) { errors.push(fileError(folder, error)); }
    };
    visit('.', 0, root.extensions);
    return { folders: [root, ...folders], databases, errors };
  }
}

export const sqlIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function sqliteTables(db: DatabaseSync) {
  return db.prepare('PRAGMA table_list').all().filter((row) =>
    row.schema === 'main' && row.type !== 'view' && row.name !== 'sqlite_schema');
}

export function sqliteColumns(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA main.table_xinfo(${sqlIdentifier(table)})`).all();
}
