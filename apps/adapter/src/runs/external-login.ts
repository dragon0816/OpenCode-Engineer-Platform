import { DelegationError } from './delegation-ledger.ts';
import type { Provider } from './external-ledger.ts';

export type LoginPrompt = { url?: string; deviceCode?: string; pasteCode?: true };
export type LoginRelay = { publish(prompt: LoginPrompt): void; bind(write: (code: string) => void): void };

export function isBrowserCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z\d_~.%+=/#-]{1,512}$/i.test(value) && !/^sk-ant-/i.test(value);
}

const oauthParameters = new Set([
  'client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method',
  'id_token_add_organizations', 'codex_cli_simplified_flow', 'originator', 'audience', 'prompt',
  'nonce', 'flow', 'resource', 'include_granted_scopes', 'utm_source',
]);

function authorizationUrl(provider: Provider, value: string) {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return;
  if (provider === 'codex_cli' && url.origin === 'https://auth.openai.com' && url.pathname === '/codex/device') {
    return url.search ? undefined : url.href;
  }
  const endpoint = url.origin + url.pathname;
  const allowed = provider === 'codex_cli' ? endpoint === 'https://auth.openai.com/oauth/authorize' :
    endpoint === 'https://claude.ai/oauth/authorize' || endpoint === 'https://claude.com/cai/oauth/authorize';
  const params = url.searchParams;
  if (!allowed || params.get('response_type') !== 'code' || !params.get('state') ||
      [...params].some(([name, value]) => (params.getAll(name).length !== 1 && name !== 'resource') ||
        (!oauthParameters.has(name) && !(provider === 'claude_code' && name === 'code' && value === 'true')))) return;
  const redirect = URL.parse(params.get('redirect_uri') ?? '');
  const loopback = redirect?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) &&
    redirect.port && ['/auth/callback', '/callback'].includes(redirect.pathname);
  const hosted = provider === 'claude_code' && redirect?.protocol === 'https:' &&
    ['platform.claude.com', 'console.anthropic.com'].includes(redirect.host) && redirect.pathname === '/oauth/code/callback';
  if ((!loopback && !hosted) || redirect?.username || redirect?.password || redirect?.search || redirect?.hash) return;
  return url.href;
}

export function loginOutput(provider: Provider, publish: LoginRelay['publish']) {
  let prompt: LoginPrompt = {};
  let deviceCodeNext = false;
  const accept = (raw: string, complete: boolean) => {
    // CLI output can contain colored text and OSC 8 links. Only typed prompts leave this parser.
    const line = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    if (provider === 'claude_code' && /^Paste (?:the )?(?:(?:one-time|authorization) )?code here\b/i.test(line)) {
      prompt = { ...prompt, pasteCode: true };
      publish(prompt);
    }
    if (!complete) return;
    const value = /https:\/\/[^\s<>"'\x00-\x1f]+/i.exec(line)?.[0] ??
      /\x1b\]8;;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/i.exec(raw)?.[1];
    const url = value && authorizationUrl(provider, value);
    if (url) {
      prompt = url === prompt.url ? prompt : { url, ...(prompt.pasteCode && { pasteCode: true }) };
      publish(prompt);
    }
    if (provider !== 'codex_cli' || !prompt.url?.endsWith('/codex/device')) return;
    if (deviceCodeNext && !line) return;
    const inlineCode = /^(?:Device|One-time|User) code:\s*([A-Z\d-]+)$/i.exec(line)?.[1];
    const code = inlineCode ?? (deviceCodeNext ? line : '');
    deviceCodeNext = /^(?:2\.\s*)?Enter this one-time code\b/i.test(line);
    if (!/^[A-Z\d]{3,5}-[A-Z\d]{3,5}$/.test(code)) return;
    prompt = { ...prompt, deviceCode: code };
    publish(prompt);
  };
  const streams = [0, 1].map(() => ({ decoder: new TextDecoder(), line: '', discard: false }));
  return (stream: 0 | 1, chunk: Uint8Array) => {
    const state = streams[stream];
    const lines = state.decoder.decode(chunk, { stream: true }).split(/\r?\n/);
    for (const [index, part] of lines.entries()) {
      const complete = index < lines.length - 1;
      state.discard ||= state.line.length + part.length > 8192;
      if (!state.discard) {
        state.line += part;
        accept(state.line, complete);
      }
      if (complete) {
        state.line = '';
        state.discard = false;
      }
    }
  };
}

export class LoginExchange implements LoginRelay {
  readonly client = new AbortController();
  prompt: LoginPrompt = {};
  #write?: (code: string) => void;
  #submitted = false;

  publish(prompt: LoginPrompt) {
    this.prompt = { ...prompt, pasteCode: this.#write && !this.#submitted ? prompt.pasteCode : undefined };
  }

  bind(write: (code: string) => void) { this.#write = write; }

  submit(code: string) {
    if (!this.prompt.pasteCode || !this.#write || this.#submitted || this.client.signal.aborted) {
      throw new DelegationError('external-auth-code-unavailable');
    }
    this.#submitted = true;
    this.prompt = { ...this.prompt, pasteCode: undefined };
    this.#write(code);
  }
}
