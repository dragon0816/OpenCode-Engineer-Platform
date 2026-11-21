import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from '../../../../packages/contracts/src/run.ts';
import { HttpError } from '../http/errors.ts';
import { convertWorkbook } from './attachments.ts';
import { workbook } from './workbook.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';

export const workbookName = 'output.xlsx';
export const workbookLimit = 256 * 1024;
export const workbookInput = (runID: string) => `generated/${runID}.json`;

export async function publishWorkbook(root: string, workspace: string, run: RunRecord) {
  const startedAt = Date.now();
  const source = workbookInput(run.id);
  const input = openWorkspaceFile(workspace, source, 64 * 1024);
  if (Number(BigInt(input.identity.created) / 1_000_000n) < run.createdAt) throw new Error('Workbook data is stale');
  let sheets: unknown;
  try { sheets = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.data)); }
  catch { throw new HttpError(422, 'The model wrote invalid workbook JSON. Try the workbook request again'); }
  const bytes = workbook(sheets);
  await convertWorkbook(Buffer.from(bytes));

  checkDirectory(root);
  const folder = scopedPath(root, run.id);
  mkdirSync(folder);
  checkDirectory(folder);
  const path = join(folder, workbookName);
  writeFileSync(path, bytes, { flag: 'wx' });
  const output = openWorkspaceFile(folder, workbookName, workbookLimit);
  if (output.identity.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Workbook changed before publication');
  return {
    artifact: { path, ...output.identity, identity: output.identity },
    receipt: { runID: run.id, programSha256: input.identity.sha256, startedAt, finishedAt: Date.now(),
      exitCode: 0, signal: null, stdout: '', stderr: '' },
  };
}
