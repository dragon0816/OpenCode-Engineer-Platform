import { spawnSync } from 'node:child_process';
import { atRepo } from '../../../launcher/src/paths.ts';
import type { RunRecord } from '../../../../packages/contracts/src/run.ts';
import { localFile } from './receipt.ts';

export function verifyArtifact(run: RunRecord, artifact: ReturnType<typeof localFile> | undefined) {
  const receipt = run.receipt;
  if (!receipt || !run.program || receipt.runID !== run.id || receipt.programSha256 !== run.program.sha256 ||
      receipt.exitCode !== 0 || receipt.signal || receipt.error || receipt.startedAt < run.createdAt ||
      receipt.finishedAt < receipt.startedAt || receipt.finishedAt > Date.now()) throw new Error('Invalid completion receipt');
  if (!artifact) throw new Error('Workbook missing or invalid');
  if (!artifact.file.bytes) throw new Error('Workbook is empty');
  if (artifact.stat.mtimeMs < receipt.startedAt || artifact.stat.birthtimeMs < receipt.startedAt ||
      artifact.stat.mtimeMs > receipt.finishedAt + 1) throw new Error('Workbook is stale');
  const oracle = spawnSync(process.env.OEP_PYTHON || 'python', [
    atRepo('tests/oracles/verify_xlsx.py'), artifact.file.path, atRepo('tests/fixtures/d08/oracle.json'),
  ], {
    windowsHide: true, encoding: 'utf8', timeout: 8_000, maxBuffer: 16_384,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PYTHONPATH: process.env.PYTHONPATH,
      PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (oracle.error || oracle.status === null) throw new Error('Workbook verifier unavailable');
  const result = JSON.parse(oracle.stdout) as { ok: boolean; cells?: number; reason?: string };
  if (oracle.status !== 0 || !result.ok || result.cells !== 13) {
    throw new Error(`Oracle rejected workbook: ${result.reason ?? 'cell count'}`);
  }
  const after = localFile(run.workspace, 'output.xlsx', 256 * 1024).file;
  if (after.sha256 !== artifact.file.sha256) throw new Error('Workbook changed during verification');
  return { artifact: artifact.file, checkedCells: result.cells };
}
