import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ModelCall } from '../../../../packages/contracts/src/run.ts';
import { jsonInput, send } from '../../../../scripts/phase0/probe-http.ts';
import { boundedUpstreamText, bufferedCompletion, redactFields, redactJson, upstreamJson } from '../../../../scripts/phase0/probe-redaction.ts';


export const providerID = 'oep-relay';
export const gatewayAliases = ['gpt-5.4-mini', 'claude-haiku-4-5-20251001'] as const;
export type GatewayTrace = ModelCall;

export function gatewaySettings() {
  let url = process.env.OEP_LITELLM_BASE_URL;
  let key = process.env.OEP_LITELLM_API_KEY;
  if ((!url || !key) && process.platform === 'win32') {
    const powershell = join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe');
    const result = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "@([Environment]::GetEnvironmentVariable('OEP_LITELLM_BASE_URL','User'),[Environment]::GetEnvironmentVariable('OEP_LITELLM_API_KEY','User')) | ConvertTo-Json -Compress"],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000 });
    const [userURL, userKey] = JSON.parse(result) as [string | null, string | null];
    url ||= userURL ?? undefined;
    key ||= userKey ?? undefined;
  }
  if (!url || !key) throw new Error('Gateway configuration is missing');
  return { url, key };
}

type RequestBody = { model?: string; stream?: boolean; messages?: unknown[] };

function observeCompletion(frames: unknown[]) {
  type Payload = { content?: unknown; tool_calls?: unknown[] };
  type Frame = {
    choices?: { delta?: Payload; message?: Payload; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const observation: Pick<GatewayTrace, 'output' | 'finishReason' | 'tokens'> = { output: 'empty' };
  for (const frame of frames as Frame[]) {
    for (const choice of frame.choices ?? []) {
      const payload = choice.delta ?? choice.message;
      if (Array.isArray(payload?.tool_calls) && payload.tool_calls.length) observation.output = 'tool';
      if (observation.output === 'empty' && typeof payload?.content === 'string' && payload.content.trim()) observation.output = 'text';
      if (choice.finish_reason && ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice.finish_reason)) {
        observation.finishReason = choice.finish_reason;
      }
    }
    if (frame.usage) {
      const { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } = frame.usage;
      if (typeof prompt === 'number' && typeof completion === 'number' && typeof total === 'number') {
        observation.tokens = { prompt, completion, total };
      }
    }
  }
  return observation;
}

export async function startGateway(options: {
  url: string; key: string; alias: string; trace: (value: GatewayTrace) => void; fetch?: typeof fetch; web?: boolean; aliases?: readonly string[];
}) {
  let configured: URL;
  try { configured = new URL(options.url); }
  catch { throw new Error('Gateway URL is invalid'); }
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password ||
      configured.search || configured.hash || !options.key) throw new Error('Gateway configuration is invalid');
  const base = configured.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  const target = new URL(configured);
  target.pathname = `${base}/v1/chat/completions`;
  const key = randomBytes(32).toString('hex');
  const redact = redactFields([options.key, options.url, configured.origin, configured.host, configured.hostname, key]);
  const credential = Buffer.from(`Bearer ${key}`);
  const allowed = options.aliases ?? [options.alias];
  async function ping(alias: string) {
    if (!allowed.includes(alias)) return false;
    try {
      const response = await (options.fetch ?? fetch)(target, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}` },
        body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'Reply with exactly OEP-READY.' }],
          stream: false, max_tokens: 16 }),
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const value = upstreamJson(await boundedUpstreamText(response)) as { choices?: unknown[] } | null;
      return Boolean(value?.choices?.length && observeCompletion([value]).output === 'text');
    } catch { return false; }
  }
  let requests = 0;
  const outages = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const started = Date.now();
    const id = ++requests;
    let status = 500;
    let upstreamStatus: number | null = null;
    let error: GatewayTrace['error'];
    let completion: ReturnType<typeof observeCompletion> | undefined;
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    outages.add(abort);
    try {
      const incoming = Buffer.from(request.headers.authorization ?? '');
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') status = 404;
      else if (incoming.length !== credential.length || !timingSafeEqual(incoming, credential)) status = 401;
      else if (!options.web && id > 55) status = 400;
      else {
        let body: RequestBody | undefined;
        try { body = await jsonInput<RequestBody>(request, options.web ? 64 * 1024 * 1024 : undefined); }
        catch { status = 400; }
        if (body?.model && allowed.includes(body.model) && Array.isArray(body.messages)) {
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]);
          const upstream = await (options.fetch ?? fetch)(target, {
            method: 'POST', redirect: 'manual', signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}` },
            body: JSON.stringify(body),
          });
          upstreamStatus = upstream.status;
          if (!upstream.ok) {
            status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
            await upstream.body?.cancel().catch(() => undefined);
          } else if (body.stream) {
            const frames = await bufferedCompletion(upstream, redact);
            completion = observeCompletion(frames);
            status = 200;
            response.writeHead(status, { 'content-type': 'text/event-stream' });
            response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
            return;
          } else {
            const value = upstreamJson(await boundedUpstreamText(upstream)) as { choices?: unknown[]; error?: unknown } | null;
            if (!Array.isArray(value?.choices) || !value.choices.length || value.error) throw new Error('Invalid completion');
            completion = observeCompletion([value]);
            status = 200;
            send(response, status, redactJson(value, redact));
            return;
          }
        } else status = 400;
      }
    } catch (reason) {
      status = abort.signal.aborted ? 499 : 502;
      error = abort.signal.aborted ? 'cancelled' :
        reason instanceof DOMException && reason.name === 'TimeoutError' ? 'timeout' :
        upstreamStatus === null ? 'transport' : 'invalid-completion';
    } finally {
      outages.delete(abort);
      options.trace({ request: id, status, upstreamStatus, elapsedMs: Date.now() - started, error, ...completion });
    }
    if (!response.destroyed && !response.headersSent) send(response, status, { error: { message: `OEP relay status ${status}` } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, key, redact, ping,
    requestCursor: () => requests,
    close: () => new Promise<void>((resolve, reject) => {
      for (const request of outages) request.abort();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
