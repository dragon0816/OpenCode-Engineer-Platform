import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [role, profile, provider, operation] = process.argv.slice(2);
const syntheticCredential = 'synthetic-subscription-credential-do-not-relay';
const code = 'synthetic-one-time-code#state';
const pin = { version: '1.2.3', sha256: 'a'.repeat(64) };

async function cli() {
  const codex = provider === 'codex_cli';
  const credentialFile = join(profile, provider + '.credential');
  const modeFile = join(profile, provider + '.mode');
  const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8') : '';
  if (operation === 'version') {
    console.log(codex ? 'codex-cli 1.2.3' : '1.2.3 (Claude Code)');
    return;
  }
  if (operation === 'status') {
    const signedIn = existsSync(credentialFile);
    process.exitCode = signedIn ? 0 : 1;
    if (codex) console.error(signedIn ? 'Logged in using ChatGPT' : 'Not logged in');
    else if (mode === 'text') console.log(signedIn ? 'Logged in using Claude.ai' : 'Not logged in');
    else console.log(JSON.stringify({
      loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', ...(signedIn && { email: 'owner@example.test' }),
      ...(mode === 'expired' && { loginExpiresAt: '2000-01-01T00:00:00Z' }),
      accessToken: syntheticCredential,
    }));
    return;
  }
  if (operation === 'logout') {
    rmSync(credentialFile, { force: true });
    return;
  }
  if (mode === 'failure') {
    console.error('Synthetic authentication error ' + syntheticCredential);
    process.exitCode = 1;
    return;
  }
  const signIn = () => writeFileSync(credentialFile, syntheticCredential);
  const malicious = 'https://auth.openai.com/oauth/authorize?response_type=code&state=state&access_token=' + syntheticCredential;
  console.log(malicious);
  if (operation === 'device') {
    console.log('\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m');
    console.log('2. Enter this one-time code (expires in 15 minutes)');
    console.log('   \x1b[94mABCD-EFGH\x1b[0m');
    const approval = join(profile, 'approve-device');
    const timer = setInterval(() => {
      if (!existsSync(approval)) return;
      rmSync(approval);
      signIn();
      clearInterval(timer);
    }, 20);
    return;
  }
  if (codex) {
    const server = createServer((request, response) => {
      if (request.url !== '/auth/callback?code=synthetic') { response.writeHead(404).end(); return; }
      signIn();
      response.end('Synthetic browser callback');
      server.close();
    });
    server.listen(0, '127.0.0.1', () => {
      const callback = 'http://127.0.0.1:' + server.address().port + '/auth/callback';
      console.error('Starting local login server on ' + callback);
      console.error('https://auth.openai.com/oauth/authorize?response_type=code&state=fixture&redirect_uri=' + encodeURIComponent(callback));
    });
    return;
  }
  const info = 'https://claude.com/cai/oauth/authorize?code=true&response_type=code&state=fixture' +
    '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';
  console.log('\x1b]8;;' + info + '\x1b\\Authorize\x1b]8;;\x1b\\');
  process.stdout.write('Paste code here if prompted > ');
  const lines = createInterface({ input: process.stdin });
  lines.once('line', (input) => {
    assert.equal(input, code);
    console.log(input);
    signIn();
    lines.close();
    process.stdin.destroy();
  });
}

function supervise() {
  const stdin = createInterface({ input: process.stdin });
  const receipt = (exit, stdout = '', stderr = '', reason) => console.log(JSON.stringify({
    exit, stdout: Buffer.from(stdout).toString('base64'), stderr: Buffer.from(stderr).toString('base64'),
    reason, members: 1, orphans: 0,
  }));
  stdin.once('line', (line) => {
    const request = JSON.parse(line);
    if (request.operation === 'inspect') {
      console.log(JSON.stringify({ isolation: 'verified', pin, copyRoot: join(profile, 'runs') }));
      stdin.close();
      process.stdin.destroy();
      return;
    }
    const { provider, operation, relay, arguments: args } = request;
    assert.deepEqual(request.pin, pin);
    const codex = provider === 'codex_cli';
    const codexConfig = ['-c', 'cli_auth_credentials_store="keyring"', '-c', 'check_for_update_on_startup=false'];
    const exact = {
      version: ['--version'], status: codex ? [...codexConfig, 'login', 'status'] : ['auth', 'status'],
      cli: codex ? [...codexConfig, 'login'] : ['auth', 'login'], device: [...codexConfig, 'login', '--device-auth'],
      logout: codex ? [...codexConfig, 'logout'] : ['auth', 'logout'],
    };
    assert.deepEqual(args, exact[operation]);
    assert.equal(relay, operation === 'cli' || operation === 'device');
    assert.equal(request.input, undefined);
    const mode = join(profile, provider + '.mode');
    const setting = existsSync(mode) ? readFileSync(mode, 'utf8') : '';
    if (relay && setting === 'old') {
      receipt(null, '', '', 'external-auth-setup-required');
      stdin.close();
      process.stdin.destroy();
      return;
    }
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), 'cli', profile, provider, operation], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const output = ['', ''];
    let timedOut = false;
    const timeout = relay && setting === 'timeout' ? setTimeout(() => { timedOut = true; proc.kill(); }, 800) : undefined;
    stdin.on('close', () => { if (proc.exitCode === null) proc.kill(); });
    stdin.on('line', (command) => {
      assert.match(command, /^code:/);
      proc.stdin.write(command.slice(5) + '\n');
    });
    proc.stdin.on('error', () => {});
    for (const [stream, index] of [[proc.stdout, 0], [proc.stderr, 1]]) {
      stream.on('data', (bytes) => {
        if (relay) {
          for (let offset = 0; offset < bytes.length; offset += 17) {
            console.log((index ? 'err:' : 'out:') + bytes.subarray(offset, offset + 17).toString('base64'));
          }
        } else output[index] += bytes.toString();
      });
    }
    proc.on('close', (exit) => {
      clearTimeout(timeout);
      receipt(timedOut ? null : exit, ...output);
      stdin.close();
      process.stdin.destroy();
    });
  });
}

if (role === 'cli') await cli();
else supervise();
