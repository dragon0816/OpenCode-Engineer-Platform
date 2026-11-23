import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [provider, mode, ...flags] = process.argv.slice(2);
const file = fileURLToPath(import.meta.url);
if (provider === 'grandchild') setInterval(() => {}, 1000);
else if (provider === 'child') {
  const child = spawn(process.execPath, [file, 'grandchild'], { stdio: 'ignore', windowsHide: true });
  child.once('spawn', () => writeFileSync('child-ready.txt', JSON.stringify([process.pid, child.pid])));
  setInterval(() => {}, 1000);
} else if (flags.includes('--version')) {
  console.log(provider === 'codex_cli' ? 'codex-cli 1.2.3' : '1.2.3 (Claude Code)');
} else if (flags.includes('status')) {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('OEP_')), false);
  const signedIn = mode !== 'signed-out';
  console.log(provider === 'codex_cli' ? (signedIn ? 'Logged in using ChatGPT' : 'Not logged in') :
    JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', email: 'synthetic@example.test' }));
  process.exitCode = signedIn ? 0 : 1;
} else {
  const task = readFileSync(0, 'utf8');
  assert.match(task, /^Synthetic owner task/);
  if (provider === 'codex_cli') {
    for (const flag of ['--ask-for-approval', 'never', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'workspace-write', '--skip-git-repo-check', 'features.hooks=false', 'features.multi_agent=false',
      'cli_auth_credentials_store="keyring"', 'sandbox_workspace_write.network_access=false', 'windows.sandbox="mxc"']) {
      assert.ok(flags.includes(flag));
    }
    assert.equal(flags.at(-1), '-');
  } else {
    for (const flag of ['--print', '--no-session-persistence', '--safe-mode', '--restricted', 'dontAsk',
      'Read,Glob,Grep,Edit,Write', 'mcp__*']) assert.ok(flags.includes(flag));
    assert.equal(flags[flags.indexOf('--max-turns') + 1], '2');
  }
  const keys = ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    ...(provider === 'codex_cli' ? ['CODEX_HOME'] : ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])];
  assert.deepEqual(Object.keys(process.env).map((key) => key.toUpperCase()).sort(), keys.map((key) => key.toUpperCase()).sort());
  if (task.includes('probe boundaries')) {
    const canary = fileURLToPath(new URL('../private/canary.txt', import.meta.url));
    const denied = (error) => error.code === 'EACCES' || error.code === 'EPERM';
    assert.throws(() => readFileSync(canary), denied);
    assert.throws(() => writeFileSync(canary, 'escaped'), denied);
    assert.throws(() => writeFileSync('../baseline.json', 'escaped'), denied);
    assert.equal(readFileSync('oep-inputs/reference.txt', 'utf8'), 'Synthetic read-only reference');
    assert.throws(() => writeFileSync('oep-inputs/reference.txt', 'escaped'), denied);
  }
  if (task.includes('output flood')) process.stdout.write('x'.repeat(1024 * 1024));
  else if (task.includes('nonzero')) process.exitCode = 4;
  else if (task.includes('bad output')) console.log('{broken');
  else {
    if (task.includes('grandchildren')) {
      spawn(process.execPath, [file, 'child'], { stdio: 'ignore', windowsHide: true }).unref();
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          try { readFileSync('child-ready.txt'); clearInterval(poll); resolve(); }
          catch { /* Wait for the grandchild to start. */ }
        }, 25);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (task.includes('hang')) setInterval(() => {}, 1000);
    else {
      writeFileSync('folder/Example.txt', 'Synthetic verified modification\r\n');
      writeFileSync('added.txt', 'Synthetic added file');
      if (task.includes('alternate stream')) writeFileSync('added.txt:hidden', 'Synthetic ignored stream');
      if (provider === 'codex_cli') {
        for (const type of ['thread.started', 'turn.started', 'turn.completed']) console.log(JSON.stringify({ type }));
      } else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Synthetic summary' }));
    }
  }
}
