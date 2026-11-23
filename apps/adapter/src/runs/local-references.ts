import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atRepo, repo } from '../../../launcher/src/paths.ts';
import { HttpError } from '../http/errors.ts';
import type { WebMessageCode } from '../http/messages.ts';
import { uploadType, uuid } from './attachments.ts';
import type { Classification } from './delegation-ledger.ts';
import type { LocalReference, ReferenceIdentity, ReferenceLedger } from './reference-ledger.ts';
import { pickLocalReference } from './reference-picker.ts';
import type { PickerKind, ReferencePicker } from './reference-picker.ts';
import { canonicalWorkspaceDirectory } from './workspace.ts';

const rangeLimit = 16 * 1024;
const batchLimit = 10;
const relativeName = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 &&
  !/[\\:\x00-\x1f]/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..');
const integer = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export type ReferenceReadArgs = { reference: string; path?: string; offset?: number; length?: number; page?: number;
  list?: boolean; after?: string };

export function referenceReadArgs(args: Record<string, unknown>): args is Record<string, unknown> & ReferenceReadArgs {
  if (typeof args.reference !== 'string' || !uuid.test(args.reference) ||
      args.path !== undefined && !relativeName(args.path)) return false;
  if (args.list === true) return Object.keys(args).every((key) => ['reference', 'path', 'list', 'after'].includes(key)) &&
    (args.after === undefined || typeof args.after === 'string' && args.after.length <= 255 && !/[\\/\x00-\x1f]/.test(args.after));
  return Object.keys(args).every((key) => ['reference', 'path', 'offset', 'length', 'page'].includes(key)) &&
    (args.offset === undefined || integer(args.offset, 0, Number.MAX_SAFE_INTEGER)) &&
    (args.length === undefined || integer(args.length, 1, rangeLimit)) &&
    (args.page === undefined || integer(args.page, 1, Number.MAX_SAFE_INTEGER));
}

export const referenceReadSchema = {
  reference: { type: 'string' }, path: { type: 'string', maxLength: 4096 },
  offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: rangeLimit },
  page: { type: 'integer', minimum: 1 }, list: { type: 'boolean' }, after: { type: 'string', maxLength: 255 },
};

function referenceType(name: string) {
  const ext = extname(name).toLowerCase();
  if (ext === '.json' || ext === '.jsonc') return 'application/json';
  if (ext === '.csv') return 'text/csv';
  try { return uploadType(name, 'application/octet-stream'); }
  catch { return 'application/octet-stream'; }
}

const identityHash = (identity: ReferenceIdentity) =>
  identity.sha256 ?? createHash('sha256').update(JSON.stringify(identity)).digest('hex');
const filetimeToMs = (time: string) => Number((BigInt(time) - 116444736000000000n) / 10_000n);
const failure = (code: WebMessageCode, status = 422) => new HttpError(status, code);
const workerErrors = new Set<WebMessageCode>([
  'reference-unavailable', 'reference-changed', 'reference-format', 'reference-range', 'reference-extraction',
]);

function workerFailure(code: WebMessageCode) {
  return workerErrors.has(code) ? failure(code, code === 'reference-changed' ? 409 : 422) : failure('reference-unavailable');
}

function protectedRoots(root: string) {
  const user = process.env.USERPROFILE;
  const local = process.env.LOCALAPPDATA;
  const installed = /^\d+\.\d+\.\d+$/.test(basename(repo)) && existsSync(join(repo, 'config/release.manifest.json'));
  return [root, installed ? dirname(repo) : repo, process.env.OEP_DATA_DIR, process.env.SystemRoot, process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'], process.env.ProgramData, process.env.APPDATA,
    ...(local ? ['OEP', 'Programs/OEP', 'Programs/OEP-Python', 'Microsoft', 'Google/Chrome', 'Mozilla', 'Packages']
      .map((path) => join(local, path)) : []),
    ...(user ? ['.t3', '.opencode', '.password-store', 'AppData/LocalLow'].map((path) => join(user, path)) : []),
  ].filter((path): path is string => Boolean(path)).map((path) => resolve(path));
}

function absolutePath(value: string) {
  if (!/^[a-z]:[\\/].+/i.test(value) || value.length > 4096 || !value.isWellFormed()) throw failure('reference-unavailable');
  return value.replaceAll('/', '\\').replace(/\\$/, '');
}

type ReferenceResult = { text?: string; chunkSha256?: string; entries?: { name: string; kind: string }[]; next: number | string | null };
type Inspection = { identity: ReferenceIdentity; directory: boolean };
type WorkerReply = { error: WebMessageCode } | Inspection | { result: ReferenceResult | { error: WebMessageCode }; member: ReferenceIdentity };
type ExternalSelection = { files: { path: string; data: string; identity: ReferenceIdentity }[] } |
  { error: 'reference-changed' | 'reference-unavailable' | 'external-input-limit' };

function covers(parent: LocalReference, path: string) {
  const tail = relative(parent.path, path);
  return tail === '' || parent.directory && !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep);
}

export class LocalReferences {
  private readonly ledger: ReferenceLedger;
  private readonly protected: string[];
  private readonly picker: ReferencePicker;
  private picking = false;

  constructor(ledger: ReferenceLedger, root: string, picker: ReferencePicker = pickLocalReference) {
    this.ledger = ledger;
    this.protected = protectedRoots(canonicalWorkspaceDirectory(root));
    this.picker = picker;
  }

  private worker(path: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerReply> {
    if (process.platform !== 'win32') throw failure('reference-unavailable');
    return new Promise((resolve, reject) => {
      const worker = execFile(process.env.OEP_PYTHON || 'python',
        ['-I', '-B', atRepo('workers/files/windows_reference.py')], {
          windowsHide: true, timeout: 12_000, maxBuffer: 160 * 1024, signal,
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
        }, (error, output) => {
          if (!error) {
            try { resolve(JSON.parse(output) as WorkerReply); return; }
            catch { /* Never report raw worker output or paths. */ }
          }
          reject(failure('reference-unavailable'));
        });
      worker.stdin?.on('error', () => { /* Child process completion determines the result. */ });
      worker.stdin?.end(JSON.stringify({ path, protected: this.protected, ...input }));
    });
  }

  private async inspect(path: string, directory?: boolean, signal?: AbortSignal) {
    const reply = await this.worker(path, { action: 'inspect', directory }, signal);
    if (!('identity' in reply)) throw failure('reference-unavailable');
    return reply;
  }

  async pick(session: string, kind: PickerKind, locale: 'en' | 'zh-TW', signal: AbortSignal, current: () => boolean) {
    if (this.picking) throw failure('reference-picker-busy', 409);
    this.picking = true;
    try {
      const paths = await this.picker(kind, locale, signal);
      return paths.length ? await this.attach(session, paths, current, signal, kind === 'folder') : [];
    } finally { this.picking = false; }
  }

  async attach(session: string, paths: string[], current: () => boolean, signal?: AbortSignal, directory?: boolean) {
    if (paths.length < 1 || paths.length > batchLimit) throw failure('reference-count', 400);
    const unique = new Map(paths.map((value) => {
      const path = absolutePath(value);
      return [path.toLowerCase(), path];
    }));
    const records: LocalReference[] = [];
    for (const path of unique.values()) {
      const inspected = await this.inspect(path, directory, signal);
      records.push({ id: randomUUID(), revision: randomUUID(), path, name: basename(path), ...inspected,
        mime: inspected.directory ? 'inode/directory' : referenceType(path), hash: identityHash(inspected.identity),
        classification: 'unclassified', createdAt: Date.now() });
    }
    if (!current() || signal?.aborted) throw failure('session-not-found', 404);
    this.ledger.add(session, records);
    return records;
  }

  get(session: string, id: string) { return this.ledger.get(session, id); }

  list(session: string) { return this.ledger.list(session); }

  confidential(path: string, selection?: LocalReference) {
    return this.ledger.protectedLocations().some((file) => covers(file, path) || selection && covers(selection, file.path));
  }

  // The helper release callback is synchronous. Use the same pinned Windows reader at admission and release.
  externalSelection(file: LocalReference, maxBytes: number, maxFileBytes: number, maxFiles: number): ExternalSelection {
    const unavailable = { error: 'reference-unavailable' } as const;
    if (process.platform !== 'win32') return unavailable;
    const result = spawnSync(process.env.OEP_PYTHON || 'python',
      ['-I', '-B', atRepo('workers/files/windows_reference.py')], {
        input: JSON.stringify({ path: file.path, protected: this.protected, action: 'external', expected: file.identity,
          directory: file.directory, maxBytes, maxFileBytes, maxFiles }),
        encoding: 'utf8', windowsHide: true, timeout: 12_000, maxBuffer: Math.ceil(maxBytes / 3) * 4 + 2 * 1024 * 1024,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
      });
    if (result.status !== 0) return unavailable;
    let selection: ExternalSelection;
    try { selection = JSON.parse(result.stdout) as ExternalSelection; }
    catch { return unavailable; }
    if ('files' in selection && file.directory && selection.files.some(({ path, identity }) => {
      const approved = this.ledger.member(file.id, path.toLowerCase());
      return approved && JSON.stringify(approved) !== JSON.stringify(identity);
    })) return { error: 'reference-changed' };
    return selection;
  }

  async reconfirm(session: string, file: LocalReference, current: () => boolean) {
    const { identity } = await this.inspect(file.path, file.directory);
    if (!current()) throw failure('session-not-found', 404);
    const updated = { ...file, revision: randomUUID(), identity, hash: identityHash(identity),
      classification: file.classification === 'public' ? 'unclassified' as const : file.classification };
    if (!this.ledger.replace(session, file, updated, 'reconfirm')) throw failure('reference-changed', 409);
    return updated;
  }

  classify(session: string, file: LocalReference, classification: Classification) {
    const updated = { ...file, revision: randomUUID(), classification };
    if (!this.ledger.replace(session, file, updated, 'classify')) throw failure('reference-changed', 409);
    return updated;
  }

  remove(session: string, file: LocalReference) {
    if (!this.ledger.revoke(session, file)) throw failure('reference-changed', 409);
  }

  async openExplorer(session: string, file: LocalReference) {
    const { identity } = await this.inspect(file.path, file.directory);
    const windows = process.env.SystemRoot;
    if (!windows || JSON.stringify(identity) !== JSON.stringify(file.identity) ||
        !this.ledger.recordAccess(session, file, 'open')) throw failure('reference-changed', 409);
    // Explorer parses /select from the raw Windows command line. The pinned path cannot contain a quote.
    const location = '"' + file.path + '"';
    const child = spawn(join(windows, 'explorer.exe'), [file.directory ? location : '/select,' + location],
      { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', env: { SystemRoot: windows, WINDIR: windows } });
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(failure('reference-unavailable', 503)));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  async read(session: string, file: LocalReference, args: ReferenceReadArgs, signal?: AbortSignal) {
    if (this.get(session, file.id)?.revision !== file.revision) throw failure('reference-changed', 409);
    if ((!file.directory && (args.path || args.list)) || (file.directory && !args.list && !args.path)) throw failure('reference-format');
    const memberKey = args.path?.toLowerCase();
    const type = args.path ? referenceType(args.path) : file.mime;
    const mode = type === 'application/pdf' ? 'pdf' : type.endsWith('spreadsheetml.sheet') ? 'xlsx' :
      type === 'text/csv' ? 'csv' : type === 'application/json' ? 'json' : type.startsWith('text/') ? 'text' : 'unsupported';
    const result = await this.worker(file.path, { action: args.list ? 'list' : 'read', expected: file.identity,
      directory: file.directory, child: args.path, member: memberKey && this.ledger.member(file.id, memberKey),
      cursor: args.after ?? '', mode, offset: args.offset ?? 0, length: args.length ?? rangeLimit, page: args.page ?? 1 }, signal);
    if ('error' in result) throw workerFailure(result.error);
    if (!('result' in result)) throw failure('reference-unavailable');
    if ('error' in result.result) throw workerFailure(result.result.error);
    signal?.throwIfAborted();
    const hash = identityHash(result.member);
    const member = memberKey ? { key: memberKey, identity: result.member, hash } : undefined;
    if (!this.ledger.recordAccess(session, file, args.list ? 'list' : 'read', member, result.result.chunkSha256)) {
      throw failure('reference-changed', 409);
    }
    return { reference: file.id, name: args.path ?? file.name, identityHash: hash, ...result.result };
  }
}

export function publicReference(file: LocalReference, workspaceClassification?: Classification, confidential = false) {
  return { id: file.id, revision: file.revision, kind: 'reference', folder: file.directory, name: file.name, location: file.path, mime: file.mime,
    bytes: file.identity.size ?? 0, modifiedAt: file.identity.modified ? filetimeToMs(file.identity.modified) : null,
    createdAt: file.createdAt, hash: file.hash, ownClassification: file.classification,
    classification: confidential || workspaceClassification === 'confidential' ? 'confidential' : file.classification };
}
