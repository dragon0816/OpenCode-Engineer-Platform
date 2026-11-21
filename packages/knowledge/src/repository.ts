import { RepositoryError, RepositoryFolder, sqlIdentifier, sqliteColumns, sqliteExtension, sqliteTables } from './repository-files.ts';
import { readBiSnapshot } from './repository-bi.ts';
import { compareRepositoryPublications, digestPattern, identifier, sha256 } from './snapshot.ts';

const repoFormat = 'aep.knowledge.repo/v1';
const tagFormat = 'aep.knowledge.tag/v1';
const publishFormat = 'aep.knowledge.publish/v1';
const tagPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const authorPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const sequenceName = /^([1-9][0-9]{0,8})\.json$/;
const isoTimestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;
const knownAreas = new Set([
  'applications', 'library', 'cards', 'commits', 'publish', 'published', 'schemas', 'tags', 'skills', 'sources',
]);

type RepoMetadata = { id?: string; title?: string; kind?: 'bi' | 'wiki'; format?: string };
type PublishRecord = {
  file: string; repo: string; tag: string; commit: string; author: string; clock: number; seq: number;
  at: string; snapshot?: unknown;
};
type Artifact = { path: string; sha256?: string; bytes?: number };
type SqliteInspection = {
  file: number; bytes: number | null; selected: boolean; path?: string;
  userVersion?: number; schemaVersion?: number; tables?: { table: string; columns: string[]; rows: number }[];
};

function readMetadata(folder: RepositoryFolder, present: boolean): RepoMetadata {
  if (!present) return {};
  const value = folder.json('repo.json');
  if ((value.format !== undefined && value.format !== repoFormat) ||
      (value.type !== 'bi' && value.type !== 'wiki')) {
    throw new RepositoryError('repo.json', 'Unsupported repository format or type.');
  }
  if (typeof value.id !== 'string' || !identifier.test(value.id) ||
      (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 512))) {
    throw new RepositoryError('repo.json', 'Invalid repository ID or title.');
  }
  return { id: value.id, title: value.title as string | undefined, kind: value.type, format: value.format as string | undefined };
}

function readPublication(folder: RepositoryFolder, file: string, author: string, seq: number, metadata: RepoMetadata): PublishRecord {
  const row = folder.json(file);
  const { format, repo, tag, commit, clock, at, snapshot } = row;
  if ((format !== undefined && format !== publishFormat) || row.author !== author || row.seq !== seq ||
      typeof repo !== 'string' || !identifier.test(repo) || (metadata.id && metadata.id !== repo) ||
      typeof tag !== 'string' || tag.length > 60 || !tagPattern.test(tag) ||
      typeof commit !== 'string' || !digestPattern.test(commit) ||
      typeof clock !== 'number' || !Number.isSafeInteger(clock) || clock < 0 ||
      typeof at !== 'string' || !isoTimestamp.test(at) || !Number.isFinite(Date.parse(at))) {
    throw new RepositoryError(file, 'Invalid publication format, identity, order, or timestamp.');
  }
  return { file, repo, tag, commit, author, seq, clock, at, snapshot };
}

function resolvePublication(folder: RepositoryFolder, metadata: RepoMetadata, errors: RepositoryError[]) {
  const found: PublishRecord[] = [];
  for (const author of folder.list('publish', true)) {
    if (author.name.startsWith('.') || (author.isFile() && !author.name.toLowerCase().endsWith('.json'))) continue;
    const directory = `publish/${author.name}`;
    try {
      if (!author.isDirectory() || !authorPattern.test(author.name)) {
        throw new RepositoryError(directory, 'Invalid publication author folder.');
      }
      for (const entry of folder.list(directory)) {
        if (entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.json')) continue;
        const file = `${directory}/${entry.name}`;
        try {
          const seq = sequenceName.exec(entry.name);
          if (!seq || !entry.isFile()) throw new RepositoryError(file, 'Invalid publication file name or type.');
          found.push(readPublication(folder, file, author.name, Number(seq[1]), metadata));
        } catch (error) {
          if (!(error instanceof RepositoryError)) throw error;
          errors.push(error);
        }
      }
    } catch (error) {
      if (!(error instanceof RepositoryError)) throw error;
      errors.push(error);
    }
  }
  const latest = found.sort(compareRepositoryPublications).at(-1);
  if (latest && found.some((record) => record.repo !== latest.repo)) {
    errors.push(new RepositoryError('publish', 'Publication records contain conflicting repository IDs.'));
  }
  return latest;
}

function resolveArtifact(folder: RepositoryFolder, latest: PublishRecord): Artifact | undefined {
  const file = `tags/${latest.tag}.json`;
  const tag = folder.json(file);
  if ((tag.format !== undefined && tag.format !== tagFormat) || tag.name !== latest.tag || tag.commit !== latest.commit) {
    throw new RepositoryError(file, 'Tag does not match its publication or commit.');
  }
  if (latest.snapshot === null) return undefined;
  if (latest.snapshot === undefined) return { path: `published/${latest.tag}.sqlite` };
  if (typeof latest.snapshot !== 'object' || Array.isArray(latest.snapshot)) {
    throw new RepositoryError(latest.file, 'Invalid snapshot descriptor.');
  }
  const { path, sha256, bytes, size } = latest.snapshot as Record<string, unknown>;
  const length = bytes === undefined ? size : bytes;
  if (typeof path !== 'string' || !path.startsWith('published/') || !sqliteExtension(path) ||
      (sha256 !== undefined && (typeof sha256 !== 'string' || !digestPattern.test(sha256))) ||
      (length !== undefined && (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0)) ||
      (bytes !== undefined && size !== undefined && bytes !== size)) {
    throw new RepositoryError(latest.file, 'Invalid SQLite snapshot path, digest, or size.');
  }
  return { path, sha256: sha256 as string | undefined, bytes: length as number | undefined };
}

function describeRepository(folder: RepositoryFolder) {
  const errors: RepositoryError[] = [];
  let metadata: RepoMetadata = {};
  let latest: PublishRecord | undefined;
  let artifact: Artifact | undefined;
  try {
    metadata = readMetadata(folder, folder.list('.').some(({ name }) => name === 'repo.json'));
    latest = resolvePublication(folder, metadata, errors);
    if (latest && !errors.length) artifact = resolveArtifact(folder, latest);
  } catch (error) {
    if (!(error instanceof RepositoryError)) throw error;
    errors.push(error);
  }
  return { metadata, latest, artifact, errors };
}

function verifyArtifact(artifact: Artifact, bytes: number, digest: string) {
  if (artifact.bytes !== undefined && bytes !== artifact.bytes) throw new RepositoryError(artifact.path, 'SQLite size mismatch.');
  if (artifact.sha256 !== undefined && digest !== artifact.sha256) throw new RepositoryError(artifact.path, 'SQLite SHA-256 mismatch.');
}

function area(file: string) {
  if (file === 'repo.json') return file;
  const top = file.split('/')[0];
  return knownAreas.has(top) ? top : 'repository';
}

export function repositoryErrorReport(error: unknown, showNames = false) {
  if (!(error instanceof RepositoryError)) return { area: 'repository', message: 'Could not read or import the repository.' };
  return { area: area(error.file), message: error.message, ...(showNames && { path: error.file }) };
}

export function inspectRepository(path: string, showNames = false) {
  const folder = new RepositoryFolder(path);
  const { folders, databases, errors } = folder.inventory();
  const { metadata, latest, artifact, errors: publishErrors } = describeRepository(folder);
  errors.push(...publishErrors);
  if (artifact && !databases.some((file) => file.path === artifact.path)) databases.push({ path: artifact.path });
  let kind = metadata.kind;
  const sqlite = databases.map<SqliteInspection>(({ path, bytes }, index) => {
    const selected = artifact?.path === path;
    const info = { file: index + 1, bytes: bytes ?? null, selected, ...(showNames && { path }) };
    try {
      return folder.sqlite(path, (db, original, digest) => {
        const tables = sqliteTables(db).filter((row) => row.type !== 'shadow').map(({ name }) => {
          const table = String(name);
          return { table, columns: sqliteColumns(db, table).map((row) => String(row.name)),
            rows: Number(db.prepare(`SELECT count(*) AS rows FROM main.${sqlIdentifier(table)}`).get()?.rows) };
        }).sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0);
        if (selected && artifact) {
          try {
            verifyArtifact(artifact, original.length, digest);
          } catch (error) {
            if (!(error instanceof RepositoryError)) throw error;
            errors.push(error);
          }
        }
        return { ...info, bytes: original.length, userVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version),
          schemaVersion: Number(db.prepare('PRAGMA schema_version').get()?.schema_version), tables };
      });
    } catch (error) {
      if (!(error instanceof RepositoryError)) throw error;
      errors.push(error);
      return info;
    }
  });
  const selected = sqlite.find((file) => file.selected);
  const selectedTables = selected?.tables;
  const artifactValid = Boolean(selectedTables && !errors.some((error) => error.file === artifact?.path));
  if (!kind && selectedTables && ['cards', 'fields'].every((table) => selectedTables.some((row) => row.table === table))) kind = 'bi';
  return {
    folders, repository: { type: kind ?? 'unknown', format: metadata.format ?? null },
    publication: {
      state: publishErrors.length ? 'unresolved' : !latest ? 'no published version' :
        artifactValid ? 'resolved' : 'artifact unavailable',
      ...(latest && !publishErrors.length && { tag: showNames ? latest.tag : 'resolved-tag',
        ...(selected && { sqlite: selected.file }) }),
      ...(artifactValid && { digestVerified: artifact?.sha256 !== undefined, sizeVerified: artifact?.bytes !== undefined }),
    },
    sqlite,
    errors: errors.map((error, index) => {
      const file = databases.findIndex(({ path }) => path === error.file) + 1;
      return { issue: index + 1, ...repositoryErrorReport(error, showNames), ...(file && { sqlite: file }) };
    }),
  };
}

export function readRepository(path: string, destination?: string) {
  const folder = new RepositoryFolder(path);
  if (destination && folder.contains(destination)) {
    throw new RepositoryError('.', 'OEP knowledge storage must be outside the source repository.');
  }
  const { metadata, latest, artifact, errors } = describeRepository(folder);
  if (errors.length) throw errors[0];
  if (!latest) throw new RepositoryError('publish', 'No published version.');
  if (metadata.kind === 'wiki') throw new RepositoryError('repo.json', 'Wiki repository folders are not supported.');
  if (!artifact) throw new RepositoryError(latest.file, 'Publication has no SQLite snapshot.');
  return folder.sqlite(artifact.path, (db, original) => {
    const generation = sha256(JSON.stringify([latest.repo, latest.clock, latest.author, latest.seq, latest.commit])).slice(0, 24);
    const snapshot = readBiSnapshot(db, artifact.path, {
      vault: { id: latest.repo, title: metadata.title ?? latest.repo, kind: 'bi' },
      publication: { revision: `${latest.tag}@${generation}`, publishedAt: latest.at, publisher: latest.author },
      repository: { tag: latest.tag, commit: latest.commit, clock: latest.clock, author: latest.author, seq: latest.seq },
    });
    return { snapshot, original, digestVerified: artifact.sha256 !== undefined, sizeVerified: artifact.bytes !== undefined };
  }, (bytes, digest) => verifyArtifact(artifact, bytes, digest));
}
