import { win32 } from 'node:path';
import { DelegationError } from './delegation-ledger.ts';
import type { Provider } from './external-ledger.ts';

export type CliVersion = `${number}.${number}.${number}`;
export type LoginState = 'unknown' | 'signedIn' | 'signedOut' | 'probeFailed' | 'reauthRequired';
export type HelperAuthAction = { action: 'cli' | 'device' | 'logout' } | { action: 'key'; key: string };
export type HelperStatus = {
  installation: 'unknown' | 'missing' | 'detected' | 'unsupported';
  isolation: 'unavailable' | 'verified';
  login: LoginState;
  version?: CliVersion;
  pinnedVersion?: CliVersion;
  account?: string;
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
  const flag = action === 'key' ? '--with-api-key' : action === 'device' ? '--device-auth' : undefined;
  return [...config, 'login', ...(flag ? [flag] : [])];
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

const accountEmail = (email: unknown) => typeof email === 'string' && email.length <= 254 &&
  /^[a-z\d.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(email) ? email : undefined;

export function cliLoginDetails(provider: Provider, exit: number, output: string): Pick<HelperStatus, 'login' | 'account'> {
  const value = output.trim();
  if (provider === 'codex_cli') {
    if (exit === 0 && /^(?:Logged in using ChatGPT|Logged in using an API key(?: - [^\r\n]{1,128})?|API key configured - [^\r\n]{1,128}(?:\r?\nAuthentication is checked when you send a request\.)?)$/.test(value)) {
      return { login: 'signedIn' };
    }
    if (exit === 1 && value === 'Not logged in') return { login: 'signedOut' };
    if (exit === 1 && /^(?:Login expired|(?:Error checking login status: )?(?:The )?(?:access |refresh )?token (?:has )?expired)[.!]?$/i.test(value)) {
      return { login: 'reauthRequired' };
    }
    return { login: 'probeFailed' };
  }
  try {
    const { loggedIn, authMethod, loginExpiresAt, email } = object(value);
    if (typeof loggedIn === 'boolean' && (authMethod === 'claude.ai' || authMethod === 'api_key' || authMethod === 'none') &&
        typeof loginExpiresAt === 'string' && Date.parse(loginExpiresAt) <= Date.now()) return { login: 'reauthRequired' };
    if (exit === 0 && loggedIn === true && (authMethod === 'claude.ai' || authMethod === 'api_key')) {
      const account = accountEmail(email);
      return { login: 'signedIn', ...(account && { account }) };
    }
    if (exit === 1 && loggedIn === false && authMethod === 'none') return { login: 'signedOut' };
  } catch {
    if (exit === 1 && /^(?:Not logged in|Not logged in\. Run claude auth login\.)$/i.test(value)) return { login: 'signedOut' };
    if (exit === 1 && /^(?:Login expired|(?:OAuth )?token (?:has )?expired)[.!]?$/i.test(value)) return { login: 'reauthRequired' };
    if (exit === 0 && /^(?:Logged in (?:with|using) (?:Claude\.ai|Claude subscription|Claude account|an API key))\.?$/i.test(value)) {
      return { login: 'signedIn' };
    }
  }
  return { login: 'probeFailed' };
}

export const cliLogin = (provider: Provider, exit: number, output: string) => cliLoginDetails(provider, exit, output).login;

export function checkCliResult(provider: Provider, output: string) {
  try {
    if (provider === 'claude_code') {
      const result = object(output);
      if (result.type === 'result' && result.subtype === 'success' && result.is_error === false && typeof result.result === 'string') {
        return result.result;
      }
    } else {
      const events = output.trimEnd().split(/\r?\n/).map(object);
      if (events[0]?.type === 'thread.started' && events.at(-1)?.type === 'turn.completed' &&
          events.filter(({ type }) => type === 'turn.started').length === 1 &&
          events.filter(({ type }) => type === 'turn.completed').length === 1 &&
          events.every(({ type }) => typeof type === 'string' && type !== 'error' && type !== 'turn.failed')) {
        return events.flatMap(({ type, item }) => {
          if (type !== 'item.completed' || !item || typeof item !== 'object') return [];
          const message = item as Record<string, unknown>;
          return message.type === 'agent_message' && typeof message.text === 'string' ? [message.text] : [];
        }).join('\n');
      }
    }
  } catch { /* Discard raw CLI output on protocol errors. */ }
  throw new DelegationError('external-cli-invalid-output');
}
