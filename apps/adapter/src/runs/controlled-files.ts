import { join } from 'node:path';
import type { FileIdentity } from '../../../../packages/contracts/src/run.ts';
import { MiB, uuid } from './attachments.ts';
import { referenceReadArgs } from './local-references.ts';
import { skillResourceArgs } from './capability-library.ts';
import { openWorkspaceFile, scopedPath } from './workspace.ts';
import { createWorkspaceOutput, writeWorkspaceFile } from './workspace-write.ts';
import type { OutputDirectory } from './workspace-write.ts';

export const fileWriteLimit = 64 * 1024;
export const workbookInput = 'workbook.json';
const filename = /^[a-z\d][a-z\d._-]{0,95}$/;

export function validOutputName(value: unknown): value is string {
  if (typeof value !== 'string' || !filename.test(value) || /^(manifest|staging)-/.test(value)) return false;
  try { scopedPath('.', value); return true; }
  catch { return false; }
}

export function fileReadArgs(args: Record<string, unknown>) {
  if ('reference' in args) return referenceReadArgs(args);
  if ('skill' in args) return skillResourceArgs(args);
  if (Object.keys(args).length !== 1) return false;
  return validOutputName(args.name) ||
    typeof args.attachment === 'string' && uuid.test(args.attachment) ||
    typeof args.artifact === 'string' && uuid.test(args.artifact);
}

export function fileWriteArgs(args: Record<string, unknown>) {
  return Object.keys(args).length === 2 && validOutputName(args.name) &&
    typeof args.content === 'string' && args.content.isWellFormed() && Buffer.byteLength(args.content) <= fileWriteLimit;
}

export class ControlledFiles {
  private directory?: OutputDirectory;
  private readonly manifest = new Map<string, { file: FileIdentity; manifestFile: FileIdentity }>();
  private readonly generated: string;
  private readonly run: string;

  constructor(generated: string, run: string) {
    this.generated = generated;
    this.run = run;
  }

  write(name: string, content: string) {
    if (!validOutputName(name) || this.manifest.has(name)) throw new Error('Output name unavailable');
    const directory = this.directory ??= createWorkspaceOutput(this.generated, this.run);
    const file = writeWorkspaceFile(directory, name, Buffer.from(content, 'utf8'), fileWriteLimit);
    const manifestFile = writeWorkspaceFile(directory, `manifest-${name}.json`,
      Buffer.from(JSON.stringify({ name, ...file })), fileWriteLimit);
    this.manifest.set(name, { file, manifestFile });
    return { name, bytes: file.bytes, sha256: file.sha256 };
  }

  read(name: string) {
    if (!validOutputName(name) || !this.directory) throw new Error('Output is unavailable');
    const record = this.manifest.get(name);
    if (!record) throw new Error('Output is unavailable');
    const { root } = this.directory;
    openWorkspaceFile(root, `manifest-${name}.json`, fileWriteLimit, record.manifestFile);
    return openWorkspaceFile(root, name, fileWriteLimit, record.file);
  }

  outputs() {
    return [...this.manifest.keys()].map((name) => ({ name, ...this.read(name) }));
  }

  get size() { return this.manifest.size; }
}

export function readFileResult(name: string, data: Buffer, sha256: string, text: boolean) {
  if (data.length > MiB) throw new Error('File exceeds the tool response limit');
  return { name, sha256, bytes: data.length, ...(text
    ? { text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
    : { base64: data.toString('base64') }) };
}

export const runFiles = (workspace: string, runID: string) => new ControlledFiles(join(workspace, 'generated'), runID);
