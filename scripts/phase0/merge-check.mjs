import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const scanner = fileURLToPath(new URL('./secret-scan.mjs', import.meta.url));
const installer = fileURLToPath(new URL('./install-hooks.mjs', import.meta.url));
const node = (script, ...args) => execFileSync(process.execPath, [script, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

try {
  const args = process.argv.slice(2);
  const merge = args[0] === '--merge';
  if (merge) args.shift();
  if (args.length !== 1 || !args[0]) throw new Error('Pass exactly one source ref.');
  const target = git('rev-parse', '--verify', 'HEAD^{commit}');
  const source = git('rev-parse', '--verify', '--end-of-options', `${args[0]}^{commit}`);
  if (merge && git('status', '--porcelain')) throw new Error('Target must be clean.');

  node(scanner, '--ref', target);
  node(scanner, '--ref', source);
  node(scanner, '--tree');
  node(scanner, '--staged');
  if (merge) {
    if (git('rev-parse', '--verify', 'HEAD^{commit}') !== target || git('status', '--porcelain')) throw new Error('Target changed after scanning.');
    git('symbolic-ref', '--quiet', 'HEAD');
    node(installer, '--from-ref', source);
    if (git('rev-parse', '--verify', 'HEAD^{commit}') !== target || git('status', '--porcelain')) throw new Error('Target changed during hook setup.');
    execFileSync('git', ['merge', '--no-ff', '--no-edit', source], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
  console.log(merge ? 'Scanned merge complete; target hooks active.' : 'Merge preflight scans passed.');
} catch {
  console.error('Phase 0 merge entry failed. Check scan results, refs, worktree and hooks.');
  process.exitCode = 1;
}
