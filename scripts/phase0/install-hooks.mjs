import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const hooks = ['pre-commit', 'pre-merge-commit', 'reference-transaction'];
const gitBytes = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
const git = (...args) => gitBytes(...args).toString('utf8').trim();
const config = (...args) => {
  try { return git('config', ...args); }
  catch (error) { if (error.status === 1) return undefined; throw error; }
};

function configureWorktree(path, hooksPath) {
  const lock = `${path}.lock`;
  const fd = openSync(lock, 'wx');
  let scratch;
  let ownLock = true;
  try {
    closeSync(fd);
    scratch = mkdtempSync(join(dirname(path), 'phase0-config-'));
    const replacement = join(scratch, 'config');
    if (existsSync(path)) copyFileSync(path, replacement);
    git('config', '--file', replacement, '--replace-all', 'core.hooksPath', hooksPath);
    git('config', '--file', replacement, '--replace-all', 'merge.ff', 'false');
    copyFileSync(replacement, lock);
    renameSync(lock, path);
    ownLock = false;
  } finally {
    if (ownLock) rmSync(lock, { force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function install(args) {
  const root = git('rev-parse', '--show-toplevel');
  const gitDir = git('rev-parse', '--absolute-git-dir');
  const snapshots = join(gitDir, 'phase0-hook-snapshots');
  const previous = config('--get', 'core.hooksPath');
  const installedSnapshot = previous && /^phase0-[\w-]+$/.test(relative(snapshots, resolve(root, previous)));
  if (previous && previous !== '.githooks' && !installedSnapshot) throw new Error('Existing custom hooks');

  let hooksPath = '.githooks';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--from-ref' || !/^[a-f\d]{40,64}$/.test(args[1])) throw new Error('Expected a reviewed commit hash');
    const source = git('rev-parse', '--verify', `${args[1]}^{commit}`);
    mkdirSync(snapshots, { recursive: true });
    hooksPath = mkdtempSync(join(snapshots, 'phase0-')).replaceAll('\\', '/');
    for (const hook of hooks) writeFileSync(join(hooksPath, hook), gitBytes('show', `${source}:.githooks/${hook}`), { mode: 0o755 });
    writeFileSync(join(hooksPath, 'secret-scan.mjs'), gitBytes('show', `${source}:scripts/phase0/secret-scan.mjs`));
  } else {
    for (const file of [...hooks.map((hook) => `.githooks/${hook}`), 'scripts/phase0/secret-scan.mjs']) {
      if (!existsSync(join(root, file))) throw new Error('Missing hook or scanner');
    }
  }

  if (config('--local', '--bool', '--get', 'extensions.worktreeConfig') !== 'true') {
    git('config', '--local', 'extensions.worktreeConfig', 'true');
  }
  const path = git('rev-parse', '--path-format=absolute', '--git-path', 'config.worktree');
  configureWorktree(path, hooksPath);
  if (config('--get', 'core.hooksPath') !== hooksPath || config('--bool', '--get', 'merge.ff') !== 'false' ||
      config('--worktree', '--get', 'core.hooksPath') !== hooksPath || config('--worktree', '--bool', '--get', 'merge.ff') !== 'false') {
    throw new Error('Hook settings not active');
  }
  console.log('Phase 0 hooks active and merge.ff=false for the current worktree.');
}

try { install(process.argv.slice(2)); }
catch {
  console.error('Could not activate Phase 0 hooks and merge settings. Check the current worktree, Git locks and existing hook configuration.');
  process.exitCode = 1;
}
