import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { maxProjection, maxUpload, uploadName, uploadType, uuid, validateAttachment } from './attachments.ts';
import type { Classification, FileManifest } from './delegation-ledger.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';
import { createWorkspaceOutput, writeWorkspaceFile } from './workspace-write.ts';
import type { Attachment } from './web-store.ts';

type HandoffInput = { record: Attachment; data: Buffer; projection?: Buffer; classification: Classification };

function verifyType(name: string, mime: string, data: Buffer) {
  if (uploadName(encodeURIComponent(name)) !== name || uploadType(name, mime) !== mime) throw new Error('Invalid handoff file');
  validateAttachment(data, mime);
}

export class DelegationHandoff {
  private readonly root: string;

  constructor(webRoot: string) {
    this.root = scopedPath(webRoot, 'delegation-handoff');
    mkdirSync(this.root, { recursive: true });
    checkDirectory(this.root);
  }

  stage(id: string, files: HandoffInput[]) {
    if (!files.length) return [];
    const folder = createWorkspaceOutput(this.root, id);
    return files.map(({ record, data, projection, classification }) => {
      verifyType(record.name, record.mime, data);
      const fileId = randomUUID();
      const identity = writeWorkspaceFile(folder, fileId + '.source', data, maxUpload, 'copy');
      const preview = projection && writeWorkspaceFile(folder, fileId + '.csv', projection, maxProjection, 'copy');
      if (record.original.sha256 !== identity.sha256 || record.projection?.sha256 !== preview?.sha256) {
        throw new Error('Handoff file changed');
      }
      return { fileId, name: record.name, bytes: identity.bytes, sha256: identity.sha256, mime: record.mime,
        sourceId: record.id, classification, identity, projection: preview };
    });
  }

  read(id: string, file: FileManifest) {
    if (!uuid.test(id) || !uuid.test(file.fileId)) throw new Error('Invalid handoff manifest');
    const root = scopedPath(this.root, id);
    const { data, identity } = openWorkspaceFile(root, file.fileId + '.source', maxUpload, file.identity);
    if (identity.sha256 !== file.sha256 || data.length !== file.bytes) throw new Error('Handoff file changed');
    verifyType(file.name, file.mime, data);
    const projection = file.projection && openWorkspaceFile(root, file.fileId + '.csv', maxProjection, file.projection).data;
    return { data, projection };
  }

  clean(hasManifest: (id: string) => boolean) {
    checkDirectory(this.root);
    for (const id of readdirSync(this.root)) {
      if (uuid.test(id) && !hasManifest(id)) this.discard(id);
    }
  }

  discard(id: string) {
    try {
      if (!uuid.test(id)) return;
      const root = scopedPath(this.root, id);
      checkDirectory(root);
      for (const name of readdirSync(root)) {
        const prefix = name.slice(0, 36);
        if ((uuid.test(prefix) && ['.source', '.csv'].includes(name.slice(36))) || /^staging-[a-f\d]{32}\.tmp$/.test(name)) {
          unlinkSync(scopedPath(root, name));
        }
      }
      rmdirSync(root);
    } catch { /* Startup retries cleanup of staging without an accepted manifest. */ }
  }
}
