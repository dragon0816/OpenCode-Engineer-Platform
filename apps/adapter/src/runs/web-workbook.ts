import { join } from 'node:path';
import type { RunRecord } from '../../../../packages/contracts/src/run.ts';
import { HttpError } from '../http/errors.ts';
import { convertWorkbook } from './attachments.ts';
import { workbookInput } from './controlled-files.ts';
import type { ControlledFiles } from './controlled-files.ts';
import { workbook } from './workbook.ts';
import { createWorkspaceOutput, writeWorkspaceFile } from './workspace-write.ts';

export const workbookName = 'output.xlsx';
export const workbookLimit = 256 * 1024;

export async function publishWorkbook(root: string, files: ControlledFiles, run: RunRecord, signal?: AbortSignal) {
  const startedAt = Date.now();
  const input = files.read(workbookInput);
  if (Number(BigInt(input.identity.created) / 1_000_000n) < run.createdAt) throw new Error('Workbook data is stale');
  let sheets: unknown;
  try { sheets = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.data)); }
  catch { throw new HttpError(422, 'workbook-data-invalid'); }
  const bytes = workbook(sheets);
  await convertWorkbook(Buffer.from(bytes));
  signal?.throwIfAborted();

  const folder = createWorkspaceOutput(root, run.id);
  const path = join(folder.root, workbookName);
  const identity = writeWorkspaceFile(folder, workbookName, Buffer.from(bytes), workbookLimit);
  return {
    artifact: { path, ...identity, identity },
    receipt: { runID: run.id, programSha256: input.identity.sha256, startedAt, finishedAt: Date.now(),
      exitCode: 0, signal: null, stdout: '', stderr: '' },
  };
}
