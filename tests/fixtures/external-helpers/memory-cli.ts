import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExternalExecutor, type ExternalIsolation } from '../../../apps/adapter/src/runs/external-executor.ts';

export function memoryHelper(root: string, beforeRelease?: () => void, authFixture?: () => ExternalIsolation | undefined) {
  const pin = { version: '1.2.3' as const, sha256: 'a'.repeat(64) };
  const launched: string[] = [];
  const isolation: ExternalIsolation = {
    async connect(provider, signal) {
      const auth = await authFixture?.()?.connect(provider, signal);
      if (auth && !('pin' in auth)) return auth;
      return {
        pin, sha256: pin.sha256,
        async probe(args) {
          const stdout = args[0] === '--version'
            ? provider === 'codex_cli' ? 'codex-cli 1.2.3' : '1.2.3 (Claude Code)'
            : provider === 'codex_cli' ? 'Logged in using ChatGPT' : '{"loggedIn":true,"authMethod":"api_key"}';
          return { exit: 0, stdout, members: 1, orphans: 0 };
        },
        ...auth,
        async run(_args, { work, prompt }, signal, release) {
          signal.throwIfAborted();
          beforeRelease?.();
          release();
          launched.push(prompt);
          writeFileSync(join(work.root, 'synthetic-result.txt'), 'Synthetic verified output\n');
          const reply = 'Synthetic external reply';
          const stdout = provider === 'codex_cli' ? [
            { type: 'thread.started' }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: reply } },
            { type: 'turn.completed' },
          ].map((event) => JSON.stringify(event)).join('\n') :
            JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply });
          return { exit: 0, stdout, members: 1, orphans: 0 };
        },
      };
    },
  };
  return { executor: new ExternalExecutor(root, isolation), launched };
}
