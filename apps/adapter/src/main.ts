import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { jsonInput, send } from '../../../scripts/phase0/probe-http.ts';
import { atRepo } from '../../launcher/src/paths.ts';
import type { Runtime } from '../../launcher/src/runtime.ts';
import { parseAsk } from '../../../packages/knowledge/src/ask.ts';
import { repositoryErrorReport } from '../../../packages/knowledge/src/repository.ts';
import { isLocalAbsoluteFolder, RepositoryError } from '../../../packages/knowledge/src/repository-files.ts';
import { LocalAuth, header } from './http/auth.ts';
import { ChatService, publicSession } from './http/chat.ts';
import type { Turn } from './http/chat.ts';
import { proposeReview, reviewAction, uploadReviewSource } from './http/review.ts';
import { HttpError } from './http/errors.ts';
import { WebEvents } from './http/events.ts';
import { download, upload } from './http/files.ts';
import { uuid } from './runs/attachments.ts';
import { WebStore } from './runs/web-store.ts';
import { checkDirectory } from './runs/workspace.ts';
import { startTelegram } from './telegram/service.ts';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['src/app.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['src/api.js', 'text/javascript; charset=utf-8']],
  ['/review.js', ['src/review.js', 'text/javascript; charset=utf-8']],
  ['/knowledge.js', ['src/knowledge.js', 'text/javascript; charset=utf-8']],
  ['/jobs.js', ['src/jobs.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['src/style.css', 'text/css; charset=utf-8']],
]);

const agents = ['inspector', 'workbook'] as const;

async function body(request: IncomingMessage) {
  if (header(request, 'content-type').split(';')[0].trim() !== 'application/json' ||
      header(request, 'content-encoding')) throw new HttpError(415, 'Expected a JSON request');
  if (!/^\d{1,6}$/.test(header(request, 'content-length')) || Number(header(request, 'content-length')) > 128 * 1024) {
    throw new HttpError(413, 'JSON request exceeds its limit');
  }
  try {
    const value = await jsonInput<unknown>(request, 128 * 1024);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Respond with a fixed error and omit untrusted details. */ }
  throw new HttpError(400, 'Invalid JSON request');
}

function parseTurn(input: Record<string, unknown>): Turn {
  const { id, text, attachments, workbook } = input;
  if (Object.keys(input).length !== 4 || typeof id !== 'string' || !uuid.test(id) ||
      typeof text !== 'string' || !text.trim() || text.length > 16_000 ||
      !Array.isArray(attachments) || attachments.length > 10 || new Set(attachments).size !== attachments.length ||
      !attachments.every((item) => typeof item === 'string' && uuid.test(item)) || typeof workbook !== 'boolean') {
    throw new HttpError(400, 'Provide a message and up to ten attachment IDs');
  }
  return { id, text, attachments, workbook };
}

function secureHeaders(response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
    "img-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; '));
}

export async function startAdapter(root: string, runtime: Runtime, requestStop: () => void, telegramEnabled = false) {
  checkDirectory(root);
  for (const name of ['sessions', 'model-work', 'artifacts']) {
    const folder = join(root, name);
    mkdirSync(folder, { recursive: true });
    checkDirectory(folder);
  }
  const store = new WebStore(join(root, 'web.sqlite'));
  const sessions = new Map(store.sessions().map((session) => [session.id, session]));
  const upstreamIDs = new Map([...sessions.values()].map((session) => [session.upstreamID, session.id]));
  const events = new WebEvents(runtime.endpoint, (id) => upstreamIDs.get(id));
  const chat = new ChatService(store, runtime, root, join(runtime.root, 'web-turns.jsonl'), (id) => events.notify(id));
  const telegram = startTelegram(root, runtime, telegramEnabled);
  const active = new Set<Promise<void>>();
  let auth: LocalAuth;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    secureHeaders(response);
    auth.check(request);
    const path = request.url ?? '';
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\\%]/.test(path)) throw new HttpError(400, 'Invalid request path');
    const method = request.method;
    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const asset = assets.get(path);
    if (asset && method === 'GET') {
      response.writeHead(200, { 'Content-Type': asset[1] }).end(readFileSync(atRepo('apps/web', asset[0])));
      return;
    }
    if (path === '/api/pair' && method === 'POST') {
      const { ticket } = await body(request);
      send(response, 200, auth.pair(request, response, ticket));
      return;
    }
    const { csrf } = auth.authorize(request);
    if (path === '/api/bootstrap' && method === 'GET') {
      send(response, 200, { csrf, agents, alias: runtime.alias, version: runtime.version,
        knowledge: Boolean(runtime.knowledge),
        sessions: [...sessions.values()].map(publicSession), job: { name: 'BI review demo', state: 'awaiting_review', demo: true } });
      return;
    }
    if (path === '/api/jobs') {
      if (method === 'POST') {
        const input = await body(request);
        try { telegram.action(input); }
        catch { throw new HttpError(422, '無法更新工作。請檢查參數及狀態。'); }
      }
      send(response, 200, telegram.status());
      return;
    }
    const source = path.match(/^\/api\/jobs\/source\/(\d+)$/);
    if (source && method === 'GET') {
      const bytes = telegram.source(Number(source[1]));
      if (!bytes) throw new HttpError(404, '找不到原始檔。');
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="telegram-source.bin"' }).end(bytes);
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/review-sources' && method === 'POST') {
      send(response, 200, await uploadReviewSource(runtime.knowledge.reviewStore, request));
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/reviews') {
      const reviewStore = runtime.knowledge.reviewStore;
      if (method === 'GET') {
        send(response, 200, { reviews: reviewStore.reviews(), ...reviewStore.reconciliation() });
      } else {
        const input = await body(request);
        try {
          if (input.action === 'propose') {
            const client = new AbortController();
            response.once('close', () => client.abort());
            const result = await proposeReview(reviewStore, input, runtime.knowledge.propose, client.signal);
            if (!response.destroyed) send(response, 200, result);
          } else send(response, 200, reviewAction(reviewStore, input));
        }
        catch { throw new HttpError(422, '審核操作失敗。請重新整理並檢查版本、證據與審核狀態。'); }
      }
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/vaults' && method === 'GET') {
      send(response, 200, { vaults: runtime.knowledge.overview() });
      return;
    }
    if (runtime.knowledge && (path === '/api/knowledge/inspect' || path === '/api/knowledge/import') && method === 'POST') {
      const input = await body(request);
      const { folder, allowModel } = input;
      const importing = path === '/api/knowledge/import';
      if (Object.keys(input).some((key) => key !== 'folder' && (!importing || key !== 'allowModel')) ||
          typeof folder !== 'string' || folder.length > 2048 || !isLocalAbsoluteFolder(folder) ||
          (allowModel !== undefined && typeof allowModel !== 'boolean')) {
        throw new HttpError(400, '請輸入本機資料夾的完整路徑。');
      }
      try {
        send(response, 200, importing ? runtime.knowledge.importRepository(folder, allowModel === true) :
          runtime.knowledge.inspectRepository(folder));
      } catch (error) {
        const report = repositoryErrorReport(error, importing);
        send(response, 422, { error: error instanceof RepositoryError
          ? [report.path, report.message].filter(Boolean).join(' · ')
          : '無法驗證或儲存此發布版本。' });
      }
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/ask' && method === 'POST') {
      const input = parseAsk(await body(request));
      if (!input) throw new HttpError(400, '請選擇一個知識庫並輸入問題。');
      const client = new AbortController();
      response.once('close', () => client.abort());
      const result = await runtime.knowledge.ask.ask(input, AbortSignal.any([client.signal, AbortSignal.timeout(76_000)]));
      if (!response.destroyed) send(response, 200, result);
      return;
    }
    if (path === '/api/stop' && method === 'POST') {
      response.once('finish', requestStop);
      send(response, 202, { state: 'stopping' });
      return;
    }
    if (path === '/api/sessions' && method === 'POST') {
      const { agent } = await body(request);
      if (agent !== 'inspector' && agent !== 'workbook') throw new HttpError(400, 'Select a supported agent');
      const session = await chat.create(agent);
      sessions.set(session.id, session);
      upstreamIDs.set(session.upstreamID, session.id);
      send(response, 201, publicSession(session));
      return;
    }
    const [, key, group, id, resource, item, extra] = path.split('/');
    const session = key === 'api' && group === 'sessions' && uuid.test(id ?? '') ? sessions.get(id) : undefined;
    if (!session || extra !== undefined) throw new HttpError(404, 'Route or session not found');
    if (method === 'GET' && resource === 'artifacts' && item && uuid.test(item)) {
      download(response, chat, session, item);
      return;
    }
    if (item !== undefined) throw new HttpError(404, 'Route not found');
    if (method === 'GET' && resource === 'state') send(response, 200, await chat.state(session));
    else if (method === 'GET' && resource === 'events') events.add(response, session.id);
    else if (method === 'POST' && resource === 'attachments') {
      const attachment = await upload(request, chat, session);
      events.notify(session.id);
      send(response, 201, attachment);
    } else if (method === 'POST' && resource === 'turns') send(response, 202, chat.submit(session, parseTurn(await body(request))));
    else throw new HttpError(404, 'Route not found');
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    const operation = handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (!request.complete) {
        response.setHeader('Connection', 'close');
        request.resume();
      }
      const detail = error instanceof HttpError ? error : new HttpError(503, 'OEP could not complete the request');
      send(response, detail.status, { error: detail.message });
    });
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        auth = new LocalAuth((server.address() as AddressInfo).port);
        resolve();
      });
    });
  } catch (error) {
    await telegram.close();
    await events.close();
    store.close();
    throw error;
  }
  return {
    pairURL: () => auth.pairURL(),
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const stopped = chat.close();
      await events.close();
      server.closeAllConnections();
      await closed;
      await Promise.all([stopped, telegram.close(), ...active]);
      store.close();
    },
  };
}
