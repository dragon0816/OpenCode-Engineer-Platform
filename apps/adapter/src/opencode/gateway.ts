import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { jsonInput, send } from '../../../../scripts/phase0/probe-http.ts';
import { boundedUpstreamText, bufferedCompletion, redactFields, redactJson, upstreamJson } from '../../../../scripts/phase0/probe-redaction.ts';

export const providerID = 'oep-relay';
export const gatewayAliases = ['gpt-5.4-mini', 'claude-haiku-4-5-20251001'] as const;
export type GatewayTrace = {
  request: number; status: number; upstreamStatus: number | null; elapsedMs: number;
  error?: 'cancelled' | 'timeout' | 'transport' | 'invalid-completion';
};

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

export async function startGateway(options: {
  url: string; key: string; alias: string; trace: (value: GatewayTrace) => void; fetch?: typeof fetch;
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
  let requests = 0;
  const outages = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const started = Date.now();
    const id = ++requests;
    let status = 500;
    let upstreamStatus: number | null = null;
    let error: GatewayTrace['error'];
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    outages.add(abort);
    try {
      const incoming = Buffer.from(request.headers.authorization ?? '');
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') status = 404;
      else if (incoming.length !== credential.length || !timingSafeEqual(incoming, credential)) status = 401;
      else if (id > 55) status = 400;
      else {
        let body: RequestBody | undefined;
        try { body = await jsonInput<RequestBody>(request); }
        catch { status = 400; }
        if (body?.model === options.alias && Array.isArray(body.messages)) {
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]);
          const upstream = await (options.fetch ?? fetch)(target, {
            method: 'POST', redirect: 'manual', signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}` },
            body: JSON.stringify(body),
          });
          upstreamStatus = upstream.status;
          if (!upstream.ok) {
            status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
            await upstream.body?.cancel();
          } else if (body.stream) {
            const frames = await bufferedCompletion(upstream, redact);
            status = 200;
            response.writeHead(status, { 'content-type': 'text/event-stream' });
            response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
            return;
          } else {
            const value = upstreamJson(await boundedUpstreamText(upstream)) as { choices?: unknown[]; error?: unknown } | null;
            if (!Array.isArray(value?.choices) || !value.choices.length || value.error) throw new Error('Invalid completion');
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
      options.trace({ request: id, status, upstreamStatus, elapsedMs: Date.now() - started, error });
    }
    if (!response.destroyed && !response.headersSent) send(response, status, { error: { message: `OEP relay status ${status}` } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, key, redact,
    close: () => new Promise<void>((resolve, reject) => {
      for (const request of outages) request.abort();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
