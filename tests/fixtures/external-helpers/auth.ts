import assert from 'node:assert/strict';
import type { CliReceipt, ExternalIsolation } from '../../../apps/adapter/src/runs/external-executor.ts';
import type { Provider } from '../../../apps/adapter/src/runs/external-ledger.ts';

const sha256 = '2'.repeat(64);
const receipt = (stdout: string, exit = 0): CliReceipt => ({ stdout, exit, members: 1, orphans: 0 });

export function fakeHelperAuth() {
  const sessions = new Map<Provider, 'cli' | 'key'>();
  const isolation: ExternalIsolation = {
    async connect(provider) {
      const codex = provider === 'codex_cli';
      return {
        pin: { version: '1.2.3', sha256 }, sha256,
        async probe(args) {
          if (args[0] === '--version') return receipt(codex ? 'codex-cli 1.2.3' : '1.2.3 (Claude Code)');
          assert.equal(args.at(-1), 'status');
          const session = sessions.get(provider);
          if (codex) return session ? receipt(session === 'cli' ? 'Logged in using ChatGPT' : 'Logged in using an API key') :
            receipt('Not logged in', 1);
          return receipt(JSON.stringify({ loggedIn: Boolean(session), authMethod: session === 'cli' ? 'claude.ai' : session === 'key' ? 'api_key' : 'none' }),
            session ? 0 : 1);
        },
        async authenticate(args, input) {
          const { action } = input;
          const codexConfig = ['-c', 'cli_auth_credentials_store="keyring"', '-c', 'check_for_update_on_startup=false'];
          if (action === 'logout') {
            assert.deepEqual(args, codex ? [...codexConfig, 'logout'] : ['auth', 'logout']);
            sessions.delete(provider);
          } else if (action === 'cli') {
            assert.deepEqual(args, codex ? [...codexConfig, 'login'] : ['auth', 'login']);
            sessions.set(provider, 'cli');
          } else if ('key' in input) {
            assert.deepEqual(args, codex ? [...codexConfig, 'login', '--with-api-key'] : []);
            assert.ok(input.key.startsWith('synthetic-'));
            assert.equal(args.includes(input.key), false);
            sessions.set(provider, 'key');
          }
        },
        async run() { assert.fail('Unexpected headless execution in an authentication fixture'); },
      };
    },
  };
  return { isolation, sessions };
}
