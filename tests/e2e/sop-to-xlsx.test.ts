import assert from 'node:assert/strict';
import { copyFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, atRepo } from '../../apps/launcher/src/paths.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { Ledger } from '../../apps/adapter/src/runs/ledger.ts';
import { excelRun, failRun, finishWorkbook, newRun, rawRecord, verifyWorkbookReceipt } from '../../apps/adapter/src/runs/excel.ts';
import { executeWorkbook, localFile } from '../../apps/adapter/src/runs/receipt.ts';
import { excelProviderFixture, workbookFixture } from './synthetic-excel.ts';

const root = dataDirectory();
const ledger = new Ledger(join(root, 'runs.sqlite'));
const report = (value: object) => console.log(JSON.stringify(value));
report({ event: 'campaign', root });

async function faults() {
  const [readings, run] = workbookFixture();
  const write = (sheets: unknown) => `writeWorkbook(${JSON.stringify(sheets)});`;
  const valid = write([readings, run]);
  const cases = [
    { mode: 'valid-control', source: valid, expected: 'verified' },
    { mode: 'nonzero-exit', source: 'throw new Error("synthetic");', expected: 'failed', error: 'Invalid completion receipt', code: 1 },
    { mode: 'wrong-program', source: 'const = ;', expected: 'failed', error: 'Invalid completion receipt', code: 1 },
    { mode: 'no-file-exit-zero', source: 'const unused = 1;', expected: 'failed', error: 'Workbook missing or invalid', code: 0 },
    { mode: 'empty-file', source: '', seed: 'empty', expected: 'failed', error: 'Workbook is empty', code: 0 },
    { mode: 'old-file', source: '', seed: 'old', expected: 'failed', error: 'Workbook is stale', code: 0 },
    { mode: 'wrong-sheet', source: write([{ ...readings, name: 'Unexpected' }, run]), expected: 'failed', error: 'Oracle rejected workbook: sheet names or order', code: 0 },
    { mode: 'wrong-value', source: write([readings, { ...run, rows: [run.rows[0], ['SYN-D08-01', 99]] }]), expected: 'failed', error: 'Oracle rejected workbook: Run.B2 type or value', code: 0 },
    { mode: 'background', hold: 'background' as const, expected: 'failed', error: 'Acceptance deadline without a receipt' },
    { mode: 'lost-connection', hold: 'indeterminate' as const, expected: 'failed', error: 'Acceptance deadline without a receipt' },
  ];
  let falsePositives = 0;
  for (const item of cases) {
    const { id, workspace } = newRun(ledger, root, item.mode);
    ledger.change(id, 'running');
    const path = join(workspace, 'output.xlsx');
    if (item.mode === 'old-file') {
      copyFileSync(atRepo('tests/fixtures/d08/expected.xlsx'), path);
      utimesSync(path, 1, 1);
    }
    let result;
    if (item.hold) {
      ledger.change(id, item.hold);
      assert.equal(ledger.get(id).receipt, undefined);
      assert.equal(ledger.get(id).state, item.hold);
      result = failRun(ledger, id, 'Acceptance deadline without a receipt');
      assert.deepEqual(ledger.history(id).map((entry) => entry.state), ['accepted', 'running', item.hold, 'failed']);
    } else {
      writeFileSync(join(workspace, 'program.js'), item.source!);
      if (item.seed === 'empty') writeFileSync(path, '');
      if (item.seed) {
        const program = localFile(workspace, 'program.js', 16 * 1024);
        ledger.change(id, 'running', { program: program.file });
        const receipt = await executeWorkbook(id, workspace, program, (value) => value);
        result = verifyWorkbookReceipt(ledger, id, receipt);
      } else result = await finishWorkbook(ledger, id);
    }
    rawRecord(root, result);
    report({ mode: item.mode, state: result.state, id, exit: result.receipt?.exitCode, errors: result.errors });
    if (item.expected === 'failed' && result.state === 'verified') falsePositives++;
    assert.equal(result.state, item.expected, item.mode);
    if (item.error) assert.deepEqual(result.errors, [item.error]);
    if (item.code !== undefined) assert.equal(result.receipt?.exitCode, item.code);
    if (item.expected === 'verified') assert.equal(result.checkedCells, 13);
  }
  report({ faults: cases.length - 1, falsePositives });
  assert.equal(falsePositives, 0);
}

async function campaign(synthetic: boolean) {
  const runtime = await startRuntime(root, synthetic ? excelProviderFixture() : undefined);
  report({ event: runtime.event, version: runtime.version, alias: runtime.alias, ipv4: runtime.ipv4, unauthorized: runtime.unauthenticated });
  try {
    let consecutive = 0;
    let longest = 0;
    for (const format of ['markdown', 'pdf', 'markdown', 'pdf', 'markdown'] as const) {
      const result = await excelRun(runtime, ledger, format);
      consecutive = result.state === 'verified' ? consecutive + 1 : 0;
      longest = Math.max(consecutive, longest);
      report({ run: result.id, format, session: result.sessionID, state: result.state, exit: result.receipt?.exitCode,
        programSha256: result.program?.sha256, artifactSha256: result.artifact?.sha256, cells: result.checkedCells, errors: result.errors });
    }
    report({ attempts: 5, longestConsecutive: longest, synthetic });
    assert.ok(longest >= 5, 'Five consecutive verified runs are required');
  } finally {
    const stopped = await runtime.stop();
    report({ event: 'stop', ...stopped });
    assert.equal(stopped.supervisorExit, 0);
    assert.equal(stopped.childExit, 0);
    assert.equal(stopped.orphans, 0);
  }
}

try {
  if (process.argv.includes('--faults')) await faults();
  else await campaign(process.argv.includes('--synthetic'));
} catch (error) {
  if (error instanceof assert.AssertionError) console.error(error.message);
  else console.error('Excel acceptance failed. See the local campaign records.');
  process.exitCode = 1;
} finally { ledger.close(); }
