import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import { maxUpload, MiB, uuid } from './attachments.ts';
import { DelegationError } from './delegation-ledger.ts';
import { helpers, type Snapshot } from './external-ledger.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';
import { createWorkspaceOutput, writeWorkspaceFile, type OutputDirectory } from './workspace-write.ts';

type Entry = { path: string; sha256: string };
type Change = { path: string; before: string | null; after: string | null };
const maxFiles = 256;
const maxTreeBytes = 40 * MiB;
// Keep project startup files, credential material and executable policy out of the copy.
const blocked = /^(?:agents(?:\.override)?\.md|claude(?:\.local)?\.md|mcp\.json|auth\.json|config\.toml|hooks\.json|credentials(?:[._-]|$)|secrets(?:[._-]|$))|\.(?:pem|pfx|key)$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function checkedPath(root: string, path: string) {
  const parts = path.split('/');
  if (parts.length > 16 || parts.some((part) => part.length > 120 || blocked.test(part) || /^staging-/i.test(part))) {
    throw new DelegationError('external-copy-unsafe');
  }
  return scopedPath(root, path);
}

function ensure(parent: string, name: string) {
  const root = scopedPath(parent, name);
  try { return createWorkspaceOutput(parent, name); }
  catch {
    // The only shared directories are created by OEP and can already exist.
    return { root, inode: String(checkDirectory(root).ino) };
  }
}

function verifyDirectory({ root, inode }: OutputDirectory) {
  if (String(checkDirectory(root, true).ino) !== inode) throw new DelegationError('external-copy-unsafe');
}

export function createExternalCopy(root: string, runId: string, provider: Snapshot['provider'], dedicatedRoot = false) {
  if (!uuid.test(runId)) throw new DelegationError('external-copy-unsafe');
  if (!dedicatedRoot) {
    const agents = ensure(root, 'agents');
    const target = ensure(agents.root, helpers[provider].id);
    root = ensure(target.root, 'external').root;
  }
  return new ExternalCopy(createWorkspaceOutput(root, runId));
}

function removeTree(folder: OutputDirectory, check: () => void) {
  verifyDirectory(folder);
  const entries: { path: string; folder?: OutputDirectory }[] = [];
  const inspect = (path: string, depth: number) => {
    check();
    if (entries.length >= maxFiles * 2 || depth > 16) throw new DelegationError('external-copy-unsafe');
    const info = lstatSync(path);
    if (!info.isDirectory() && !info.isFile()) throw new DelegationError('external-copy-unsafe');
    const directory = info.isDirectory() ? { root: path, inode: String(checkDirectory(path).ino) } : undefined;
    entries.push({ path, folder: directory });
    if (directory) for (const name of readdirSync(path)) inspect(scopedPath(path, name), depth + 1);
  };
  inspect(folder.root, 0);
  for (const { path, folder: directory } of entries.reverse()) {
    if (directory) { verifyDirectory(directory); rmdirSync(path); }
    else unlinkSync(path);
  }
}

class ExternalCopy {
  readonly run: OutputDirectory;
  constructor(run: OutputDirectory) { this.run = run; }

  stage(snapshot: Snapshot, check: () => void) {
    const { root } = this.run;
    verifyDirectory(this.run);
    const work = createWorkspaceOutput(root, 'work');
    const inputs = createWorkspaceOutput(work.root, 'oep-inputs');
    const scratch = createWorkspaceOutput(root, 'scratch');
    const folders = new Map([[work.root, work], [inputs.root, inputs]]);
    const paths = new Set<string>();
    const baseline: Entry[] = [];
    const fixedInputs = new Map<string, ReturnType<typeof writeWorkspaceFile>>();
    const bytes = Buffer.from(snapshot.content);
    let offset = 0;
    const read = (entry: { bytes: number; sha256: string }) => {
      check();
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maxUpload || entry.bytes + offset > bytes.length) {
        throw new DelegationError('external-changed');
      }
      const data = bytes.subarray(offset, offset + entry.bytes);
      offset += entry.bytes;
      if (sha256(data) !== entry.sha256) throw new DelegationError('external-changed');
      return data;
    };
    const put = (folder: OutputDirectory, path: string, data: Buffer) => {
      const target = checkedPath(folder.root, path);
      if (paths.has(target.toLowerCase())) throw new DelegationError('external-copy-unsafe');
      paths.add(target.toLowerCase());
      const parts = path.split('/');
      const name = parts.pop()!;
      for (const part of parts) {
        const key = join(folder.root, part);
        if (!folders.has(key)) folders.set(key, createWorkspaceOutput(folder.root, part, true));
        folder = folders.get(key)!;
        verifyDirectory(folder);
      }
      return writeWorkspaceFile(folder, name, data, maxUpload, 'external-copy');
    };
    const task = utf8.decode(read(snapshot.manifest.task));
    const references: string[] = [];
    for (const entry of snapshot.manifest.inputs) {
      const data = read(entry);
      if (entry.kind === 'workspace') {
        if (/^oep-inputs(?:\/|$)/i.test(entry.name)) throw new DelegationError('external-copy-unsafe');
        baseline.push({ path: entry.name, sha256: put(work, entry.name, data).sha256 });
      } else {
        fixedInputs.set(entry.name, put(inputs, entry.name, data));
        references.push('oep-inputs/' + entry.name);
      }
      if (entry.projection) {
        const path = entry.name + '.projection.txt';
        fixedInputs.set(path, put(inputs, path, read(entry.projection)));
        references.push('oep-inputs/' + path);
      }
    }
    if (offset !== bytes.length) throw new DelegationError('external-changed');
    const record = Buffer.from(JSON.stringify(baseline));
    const baselineIdentity = writeWorkspaceFile(this.run, 'baseline.json', record, maxUpload, 'copy');
    const prompt = references.length ? task + '\n\nApproved reference files:\n' + references.join('\n') : task;
    return { work, inputs, scratch, prompt, baseline, baselineIdentity, fixedInputs };
  }

  collect(copy: ReturnType<ExternalCopy['stage']>, check: () => void) {
    verifyDirectory(this.run);
    verifyDirectory(copy.work);
    verifyDirectory(copy.inputs);
    for (const [path, before] of copy.fixedInputs) {
      check();
      // The boundary may change Windows security metadata while mounting the read-only input tree.
      const { identity } = openWorkspaceFile(copy.inputs.root, path, maxUpload, undefined, true);
      if (identity.device !== before.device || identity.inode !== before.inode || identity.created !== before.created ||
          identity.bytes !== before.bytes || identity.sha256 !== before.sha256) throw new DelegationError('external-copy-unsafe');
    }
    const baseline = openWorkspaceFile(this.run.root, 'baseline.json', maxUpload, copy.baselineIdentity, true);
    if (baseline.data.toString('utf8') !== JSON.stringify(copy.baseline)) throw new DelegationError('external-copy-unsafe');
    const before = new Map(copy.baseline.map(({ path, sha256: hash }) => [path, hash]));
    const changes: Change[] = [];
    const seen = new Set<string>();
    let total = 0;
    const walk = (path = '') => {
      for (const name of readdirSync(path ? checkedPath(copy.work.root, path) : copy.work.root).sort()) {
        check();
        if (!path && name === 'oep-inputs') continue;
        const relative = path ? `${path}/${name}` : name;
        const full = checkedPath(copy.work.root, relative);
        const key = relative.toLowerCase();
        if (seen.has(key) || seen.size >= maxFiles) throw new DelegationError('external-output-limit');
        seen.add(key);
        if (lstatSync(full).isDirectory()) { checkDirectory(full, true); walk(relative); continue; }
        const file = openWorkspaceFile(copy.work.root, relative, Math.min(maxUpload, maxTreeBytes - total), undefined, true);
        total += file.data.length;
        const prior = before.get(relative) ?? null;
        if (prior !== file.identity.sha256) {
          if (file.data.includes(0)) throw new DelegationError('external-copy-unsafe');
          utf8.decode(file.data);
          changes.push({ path: relative, before: prior, after: file.identity.sha256 });
        }
        before.delete(relative);
      }
    };
    walk();
    for (const [path, hash] of before) changes.push({ path, before: hash, after: null });
    const manifest = Buffer.from(JSON.stringify(changes));
    check();
    const { sha256: manifestSha256 } = writeWorkspaceFile(this.run, 'changed-files.json', manifest, maxUpload, 'copy');
    return { count: changes.length, manifestSha256 };
  }

  discard(check: () => void) { removeTree(this.run, check); }
  clearScratch(scratch: OutputDirectory, check: () => void) { removeTree(scratch, check); }
}
