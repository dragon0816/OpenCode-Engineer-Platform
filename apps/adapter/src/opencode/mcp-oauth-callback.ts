import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebMessageError } from '../http/errors.ts';

const clean = "history.replaceState(null, '', location.pathname)";
const scriptHash = createHash('sha256').update(clean).digest('base64');

function respond(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
  response.end(`<!doctype html><meta charset="utf-8"><title>OEP</title><p>${message}</p><script>${clean}</script>`);
}

export async function listenForMcpOAuth(state: string, issuer: string, requireIssuer: boolean, signal: AbortSignal,
  exchange: (code: string, redirect: string) => Promise<void>, failed: () => void) {
  let redirect: string;
  let used = false;
  const listener = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 12_288 }, (request, response) => {
    const callback = URL.parse(request.url ?? '', redirect);
    if (request.method !== 'GET' || request.headers.host !== new URL(redirect).host || callback?.origin !== new URL(redirect).origin ||
        callback.pathname !== '/oauth/callback') { respond(response, 404, 'OEP'); return; }
    const params = callback.searchParams;
    const sameState = params.get('state') ?? '';
    const responseIssuer = params.get('iss');
    const valid = !used && !signal.aborted && params.getAll('state').length === 1 &&
      Buffer.byteLength(sameState) === state.length && timingSafeEqual(Buffer.from(sameState), Buffer.from(state)) &&
      params.getAll('iss').length <= 1 && (responseIssuer === null ? !requireIssuer : responseIssuer === issuer);
    if (!valid) { respond(response, 400, '登入回應無效。 Invalid sign-in response.'); return; }
    used = true;
    void (async () => {
      try {
        const code = params.get('code');
        if (params.has('error') || !code || code.length > 4096 || params.getAll('code').length !== 1) {
          throw new WebMessageError('mcp-oauth-login');
        }
        await exchange(code, redirect);
        respond(response, 200, '登入成功，請回到 OEP。 Signed in. Return to OEP.');
      } catch {
        failed();
        respond(response, 400, '登入未完成，請回到 OEP。 Sign-in incomplete. Return to OEP.');
      } finally { listener.close(); }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { listener.removeListener('error', reject); resolve(); });
  });
  redirect = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/oauth/callback`;
  const close = () => { listener.close(); listener.closeAllConnections(); };
  if (signal.aborted) close();
  listener.once('close', () => signal.removeEventListener('abort', close));
  signal.addEventListener('abort', close, { once: true });
  return redirect;
}
