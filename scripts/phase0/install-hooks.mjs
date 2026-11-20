import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
try {
  const root = git('rev-parse', '--show-toplevel');
  if (!['pre-commit', 'pre-merge-commit'].every((hook) => existsSync(join(root, '.githooks', hook)))) throw new Error('missing hook');
  try {
    const previous = git('config', '--get', 'core.hooksPath');
    if (previous && previous !== '.githooks') throw new Error('existing hooks');
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  git('config', '--local', 'extensions.worktreeConfig', 'true');
  git('config', '--worktree', 'core.hooksPath', '.githooks');
  if (git('config', '--get', 'core.hooksPath') !== '.githooks') throw new Error('hook path not active');
  console.log('Installed .githooks for the current worktree.');
} catch {
  console.error('Could not activate .githooks. Check the current worktree and existing hook configuration.');
  process.exitCode = 1;
}
