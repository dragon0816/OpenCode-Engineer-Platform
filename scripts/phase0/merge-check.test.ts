import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const script = resolve('scripts/phase0/merge-check.mjs');
const installer = resolve('scripts/phase0/install-hooks.mjs');
const hooks = ['.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/reference-transaction'];
const syntheticHost = ['fixture', 'internal'].join('.');

test('scanner detects UTF BOMs, BOM-less UTF-16, and ASCII-compatible legacy text', async () => {
  const scanner = await import(pathToFileURL(resolve('scripts/phase0/secret-scan.mjs')).href);
  const le = Buffer.from(syntheticHost, 'utf16le');
  const be = Buffer.from(le).swap16();
  const utf32 = Buffer.alloc(syntheticHost.length * 4);
  for (let index = 0; index < syntheticHost.length; index++) utf32.writeUInt32BE(syntheticHost.charCodeAt(index), index * 4);
  for (const bytes of [le, be, Buffer.concat([Buffer.from([255, 254]), le]), Buffer.concat([Buffer.from([254, 255]), be]),
    Buffer.concat([Buffer.from([0, 0, 254, 255]), utf32]), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(syntheticHost)]),
    Buffer.concat([Buffer.from([0xe9, 32]), Buffer.from(syntheticHost)])]) {
    assert.deepEqual(scanner.detect(scanner.decodeText(bytes)), ['internal hostname']);
  }
  assert.deepEqual(scanner.detect(scanner.decodeText(Buffer.from('approved fixture', 'utf16le'))), []);
});

test('scanned merge installs atomically and real Git blocks tainted commits, merges and fast-forwards in throwaway clones', () => {
  mkdirSync('.phase0', { recursive: true });
  const scratch = mkdtempSync(resolve('.phase0', 'merge-canary-'));
  const origin = join(scratch, 'origin');
  const clone = join(scratch, 'clone');
  mkdirSync(origin);
  const run = (cwd: string, command: string, ...args: string[]) => spawnSync(command, args, { cwd, encoding: 'utf8' });
  const git = (cwd: string, ...args: string[]) => run(cwd, 'git', ...args);
  const correct = (cwd: string, ...args: string[]) => {
    const result = git(cwd, ...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const setupAuthor = (cwd: string) => {
    correct(cwd, 'config', 'user.name', 'Fixture');
    correct(cwd, 'config', 'user.email', 'fixture@example.invalid');
  };
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from(syntheticHost, 'utf16le')]);
  try {
    correct(origin, 'init', '-q', '-b', 'main');
    setupAuthor(origin);
    writeFileSync(join(origin, 'README.md'), 'Safe fixture');
    correct(origin, 'add', 'README.md');
    correct(origin, 'commit', '-m', 'Create target fixture');
    correct(origin, 'switch', '-c', 'clean-source');
    for (const file of ['scripts/phase0/install-hooks.mjs', 'scripts/phase0/secret-scan.mjs', 'scripts/phase0/merge-check.mjs', ...hooks]) {
      const target = join(origin, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
    correct(origin, 'add', '.');
    correct(origin, 'add', '--chmod=+x', ...hooks);
    correct(origin, 'commit', '-m', 'Add clean source fixture');
    correct(origin, 'switch', '-c', 'scan-canary');
    writeFileSync(join(origin, 'canary.txt'), utf16);
    correct(origin, 'add', 'canary.txt');
    correct(origin, 'commit', '-m', 'Create synthetic contaminated ref');

    correct(scratch, 'clone', '--branch', 'main', '--no-local', origin, clone);
    setupAuthor(clone);
    const before = correct(clone, 'rev-parse', 'HEAD');
    assert.equal(existsSync(join(clone, '.githooks')), false);
    const blockedMerge = run(clone, process.execPath, script, '--merge', 'origin/scan-canary');
    assert.notEqual(blockedMerge.status, 0);
    assert.match(blockedMerge.stdout, /"hits":1/);
    assert.equal(correct(clone, 'rev-parse', 'HEAD'), before);
    for (const name of ['config.lock', 'config.worktree.lock']) {
      const lock = join(clone, '.git', name);
      writeFileSync(lock, 'Synthetic lock', { flag: 'wx' });
      const locked = run(clone, process.execPath, script, '--merge', 'origin/clean-source');
      assert.notEqual(locked.status, 0);
      assert.match(locked.stderr, /Could not activate Phase 0 hooks/);
      assert.equal(correct(clone, 'rev-parse', 'refs/heads/main'), before);
      assert.equal(correct(clone, 'status', '--porcelain'), '');
      assert.equal(git(clone, 'config', '--get', 'core.hooksPath').status, 1);
      assert.equal(git(clone, 'config', '--get', 'merge.ff').status, 1);
      assert.equal(readFileSync(lock, 'utf8'), 'Synthetic lock');
      rmSync(lock);
    }

    const merged = run(clone, process.execPath, script, '--merge', 'origin/clean-source');
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    assert.equal(correct(clone, 'branch', '--show-current'), 'main');
    const installed = correct(clone, 'config', '--worktree', '--get', 'core.hooksPath');
    assert.match(installed, /phase0-hook-snapshots\/phase0-[\w-]+$/);
    assert.ok(hooks.every((hook) => existsSync(join(installed, hook.split('/')[1]))));
    assert.equal(correct(clone, 'config', '--worktree', '--get', 'merge.ff'), 'false');
    const verified = correct(clone, 'rev-parse', 'HEAD');

    writeFileSync(join(clone, 'canary.txt'), utf16);
    correct(clone, 'add', 'canary.txt');
    const blockedCommit = git(clone, 'commit', '-m', 'Attempt UTF-16 staged canary');
    assert.notEqual(blockedCommit.status, 0);
    assert.match(blockedCommit.stdout + blockedCommit.stderr, /"hits":1/);
    assert.equal(correct(clone, 'rev-parse', 'HEAD'), verified);
    correct(clone, 'restore', '--staged', 'canary.txt');
    rmSync(join(clone, 'canary.txt'));
    assert.equal(correct(clone, 'status', '--porcelain'), '');

    for (const [name, options] of [['direct-merge', []], ['direct-ff', ['--ff-only']]] as const) {
      const direct = join(scratch, name);
      correct(scratch, 'clone', '--branch', 'main', '--no-local', origin, direct);
      setupAuthor(direct);
      const source = correct(direct, 'rev-parse', 'origin/clean-source');
      const setup = run(direct, process.execPath, installer, '--from-ref', source);
      assert.equal(setup.status, 0, setup.stdout + setup.stderr);
      assert.equal(correct(direct, 'config', '--worktree', '--get', 'merge.ff'), 'false');
      correct(direct, 'merge-base', '--is-ancestor', 'HEAD', 'origin/scan-canary');
      const unsafe = git(direct, 'merge', ...options, 'origin/scan-canary');
      assert.notEqual(unsafe.status, 0);
      assert.match(unsafe.stdout + unsafe.stderr, /"hits":1/);
      assert.equal(correct(direct, 'rev-parse', 'refs/heads/main'), before);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
