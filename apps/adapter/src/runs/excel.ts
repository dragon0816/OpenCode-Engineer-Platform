import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from '../../../../packages/contracts/src/run.ts';
import { atRepo } from '../../../launcher/src/paths.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { createSession, promptID, submitOnce } from '../opencode/sessions.ts';
import { call } from '../opencode/client.ts';
import { submissionCount, waitForOutcome } from '../opencode/reconcile.ts';
import { verifyArtifact } from './artifacts.ts';
import type { Ledger } from './ledger.ts';
import { executeWorkbook, localFile } from './receipt.ts';

const fixtures = atRepo('tests/fixtures/d08');
const instructions = `Follow the synthetic SOP. Use the write tool to create program.js in your current workspace.
Write plain JavaScript source, with no import, filesystem API, markdown fences or console. The runner executes it.
Call writeWorkbook exactly once with an array of sheets, each an object {name: string, rows: array of row arrays}.
Cells can be strings, numbers or booleans. Include the exact sheet order and cell types from the SOP.
Only write program.js. After the tool succeeds, reply with a short confirmation.`;

export function newRun(ledger: Ledger, root: string, mode: string, alias?: string) {
  const id = randomUUID();
  const workspace = mkdtempSync(join(root, 'work-'));
  return ledger.create({ id, state: 'accepted', createdAt: Date.now(), workspace, mode, alias, retries: 0, errors: [] });
}

export function failRun(ledger: Ledger, id: string, reason: string) {
  const previous = ledger.get(id);
  return ledger.change(id, 'failed', { errors: [...previous.errors, reason], finishedAt: Date.now() });
}

export function rawRecord(root: string, run: RunRecord) {
  appendFileSync(join(root, 'attempts.jsonl'), `${JSON.stringify(run)}\n`);
}

export async function finishWorkbook(ledger: Ledger, id: string, redact = (value: string) => value) {
  const run = ledger.get(id);
  let program: ReturnType<typeof localFile>;
  try { program = localFile(run.workspace, 'program.js', 16 * 1024); }
  catch { return failRun(ledger, id, 'Generated program missing or invalid'); }
  ledger.change(id, 'background', { program: program.file });
  const receipt = await executeWorkbook(id, run.workspace, program, redact);
  return verifyWorkbookReceipt(ledger, id, receipt);
}

export function verifyWorkbookReceipt(ledger: Ledger, id: string, receipt: NonNullable<RunRecord['receipt']>) {
  const ready = ledger.change(id, 'running', { receipt });
  let artifact: ReturnType<typeof localFile> | undefined;
  try { artifact = localFile(ready.workspace, 'output.xlsx', 256 * 1024); }
  catch { /* Verification records a missing or invalid artifact. */ }
  if (artifact) ledger.change(id, 'running', { artifact: artifact.file });
  try {
    const verified = verifyArtifact(ready, artifact);
    return ledger.change(id, 'verified', { ...verified, finishedAt: Date.now() });
  } catch (error) {
    return failRun(ledger, id, error instanceof Error ? error.message : 'Workbook verification failed');
  }
}

export async function excelRun(runtime: Runtime, ledger: Ledger, format: 'markdown' | 'pdf') {
  const { client, root, alias } = runtime;
  const gatewayCursor = runtime.gatewayCursor();
  const { id, workspace } = newRun(ledger, root, format, alias);
  let sessionID: string | undefined;
  let stage = 'prepare input';
  let mayBeActive = false;
  try {
    if (format === 'markdown') copyFileSync(join(fixtures, 'sop.md'), join(workspace, 'sop.md'));
    const files = format === 'pdf' ? [{
      uri: `data:application/pdf;base64,${readFileSync(join(fixtures, 'sop.pdf')).toString('base64')}`, name: 'sop.pdf',
    }] : undefined;
    stage = 'create session';
    sessionID = await createSession(client, workspace, 'workbook', alias);
    const submissionID = promptID();
    ledger.change(id, 'running', { sessionID, submissionID });
    stage = 'admit prompt';
    mayBeActive = true;
    const admitted = await submitOnce(client, { sessionID, id: submissionID, files,
      text: `${format === 'markdown' ? 'Read the local sop.md file first.' : 'Use the attached SOP PDF.'}\n${instructions}` });
    if (admitted === 'indeterminate') {
      ledger.change(id, 'indeterminate', { errors: ['Prompt admission could not be reconciled'] });
      throw new Error('Uncertain admission');
    }
    stage = 'await model';
    const outcome = await waitForOutcome(client, sessionID, (state) => { ledger.change(id, state); });
    mayBeActive = false;
    const count = await submissionCount(client, sessionID, submissionID);
    if (count.inbox !== 0 || count.messages !== 1) return failRun(ledger, id, 'Unexpected durable submission count');
    if (outcome !== 'succeeded') return failRun(ledger, id, `OpenCode outcome: ${outcome}`);
    const requests = runtime.gatewaySince(gatewayCursor);
    if (!requests.length || requests.some((request) => request.status !== 200)) {
      return failRun(ledger, id, 'Gateway request failed during the run');
    }
    stage = 'run workbook program';
    if (existsSync(join(workspace, 'output.xlsx'))) return failRun(ledger, id, 'Workbook was present before execution');
    return await finishWorkbook(ledger, id, runtime.redact);
  } catch {
    if (sessionID && mayBeActive) {
      const previous = ledger.get(id);
      if (previous.state !== 'indeterminate') {
        ledger.change(id, 'indeterminate', { errors: [...previous.errors, `Uncertain execution during ${stage}`] });
      }
      try { await client.session.interrupt({ sessionID }, call()); }
      catch { return failRun(ledger, id, 'Deadline reached and interrupt failed'); }
    }
    return failRun(ledger, id, `Run failed during ${stage}`);
  } finally {
    rawRecord(root, ledger.get(id));
  }
}
