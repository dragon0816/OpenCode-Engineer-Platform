import { win32 } from 'node:path';
import { DelegationError } from './delegation-ledger.ts';
import type { Provider } from './external-ledger.ts';

export type CliVersion = `${number}.${number}.${number}`;
export type LoginState = 'unknown' | 'signedIn' | 'signedOut' | 'probeFailed' | 'reauthRequired';
export type HelperAuthAction = { action: 'cli' | 'logout' } | { action: 'key'; key: string };
export type HelperStatus = {
  installation: 'unknown' | 'missing' | 'detected' | 'unsupported';
  isolation: 'unavailable' | 'verified';
  login: LoginState;
  version?: CliVersion;
  pinnedVersion?: CliVersion;
};

export const unavailableHelper: HelperStatus = { installation: 'unknown', isolation: 'unavailable', login: 'unknown' };
export const helperReady = (status: HelperStatus) =>
  status.isolation === 'verified' && status.installation === 'detected' && status.login === 'signedIn';

const codexAuth = ['-c', 'cli_auth_credentials_store="keyring"'];
const claudeTools = 'Read,Glob,Grep,Edit,Write';
const codexConfig = [
  'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'features.memories=false',
  'features.goals=false', 'features.multi_agent=false', 'web_search="disabled"', 'mcp_servers={}',
  'sandbox_workspace_write.network_access=false', 'check_for_update_on_startup=false', 'windows.sandbox="mxc"',
];

export function cliEnvironment(provider: Provider, paths: {
  windows: string; runtime: string; profile: string; localAppData: string; roaming: string; home: string; scratch: string;
}) {
  if (Object.values(paths).some((path) => !/^[a-z]:\\[^\u0000-\u001f;]*$/i.test(path) || win32.normalize(path) !== path)) {
    throw new DelegationError('external-isolation-unavailable');
  }
  return {
    SystemRoot: paths.windows, WINDIR: paths.windows, PATH: `${paths.runtime};${win32.join(paths.windows, 'System32')}`,
    USERPROFILE: paths.profile, APPDATA: paths.roaming, LOCALAPPDATA: paths.localAppData, TMP: paths.scratch, TEMP: paths.scratch,
    ...(provider === 'codex_cli' ? { CODEX_HOME: paths.home } :
      { CLAUDE_CONFIG_DIR: paths.home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
  };
}

export function cliArgs(provider: Provider, operation: 'version' | 'login' | 'run', turns = 0) {
  if (operation === 'version') return ['--version'];
  if (provider === 'codex_cli') {
    if (operation === 'login') return [...codexAuth, '-c', 'check_for_update_on_startup=false', 'login', 'status'];
    return ['--ask-for-approval', 'never', ...codexAuth, ...codexConfig.flatMap((value) => ['-c', value]),
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-'];
  }
  if (operation === 'login') return ['auth', 'status'];
  if (!Number.isSafeInteger(turns) || turns < 1) throw new DelegationError('external-budget-unavailable');
  return ['--print', '--input-format', 'text', '--output-format', 'json', '--no-session-persistence', '--safe-mode',
    '--restricted', '--permission-mode', 'dontAsk', '--tools', claudeTools, '--allowedTools', claudeTools,
    '--disallowedTools', 'mcp__*', '--max-turns', String(turns)];
}

export function cliAuthArgs(provider: Provider, action: HelperAuthAction['action']) {
  if (provider === 'claude_code') return action === 'key' ? [] : ['auth', action === 'logout' ? 'logout' : 'login'];
  const config = [...codexAuth, '-c', 'check_for_update_on_startup=false'];
  if (action === 'logout') return [...config, 'logout'];
  return [...config, 'login', ...(action === 'key' ? ['--with-api-key'] : [])];
}

export function cliVersion(provider: Provider, output: string): CliVersion | undefined {
  const pattern = provider === 'codex_cli' ? /^codex-cli (\d{1,5}\.\d{1,5}\.\d{1,5})$/ : /^(\d{1,5}\.\d{1,5}\.\d{1,5}) \(Claude Code\)$/;
  return pattern.exec(output.trim())?.[1] as CliVersion | undefined;
}

function object(input: string): Record<string, unknown> {
  const data: unknown = JSON.parse(input);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a CLI protocol object');
  return data as Record<string, unknown>;
}

export function cliLogin(provider: Provider, exit: number, output: string): LoginState {
  if (provider === 'codex_cli') {
    if (exit === 0 && /^(?:Logged in using ChatGPT|Logged in using an API key(?: - [^\r\n]{1,128})?)(?:\r?\n)?$/.test(output)) return 'signedIn';
    if (exit === 1 && /^Not logged in(?:\r?\n)?$/.test(output)) return 'signedOut';
    return 'probeFailed';
  }
  try {
    const { loggedIn, authMethod, loginExpiresAt } = object(output);
    if (exit === 0 && loggedIn === true && (authMethod === 'claude.ai' || authMethod === 'api_key')) {
      return typeof loginExpiresAt === 'string' && Date.parse(loginExpiresAt) <= Date.now() ? 'reauthRequired' : 'signedIn';
    }
    if (exit === 1 && loggedIn === false && authMethod === 'none') return 'signedOut';
  } catch { /* Fail closed on unknown protocol output. */ }
  return 'probeFailed';
}

export function checkCliResult(provider: Provider, output: string) {
  try {
    if (provider === 'claude_code') {
      const result = object(output);
      if (result.type === 'result' && result.subtype === 'success' && result.is_error === false && typeof result.result === 'string') return;
    } else {
      const events = output.trimEnd().split(/\r?\n/).map(object);
      if (events[0]?.type === 'thread.started' && events.at(-1)?.type === 'turn.completed' &&
          events.filter(({ type }) => type === 'turn.started').length === 1 &&
          events.filter(({ type }) => type === 'turn.completed').length === 1 &&
          events.every(({ type }) => typeof type === 'string' && type !== 'error' && type !== 'turn.failed')) return;
    }
  } catch { /* Discard raw CLI output on protocol errors. */ }
  throw new DelegationError('external-cli-invalid-output');
}
