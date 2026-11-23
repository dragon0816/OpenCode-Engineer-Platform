import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../../../../scripts/phase0/probe-http.ts';
import { header } from '../http/auth.ts';
import { HttpError } from '../http/errors.ts';
import type { WebMessageCode } from '../http/messages.ts';
import { pluginID } from './package.ts';
import type { PluginRegistry } from './registry.ts';
import { sourceLimit, type PluginRuntime } from './runtime.ts';
import { archiveLimit, PluginError } from './zip.ts';

const errors: Record<string, [number, WebMessageCode]> = {
  'invalid-package': [400, 'plugin-invalid-package'],
  'digest-mismatch': [400, 'plugin-digest-mismatch'],
  'compatibility-consent': [409, 'plugin-compatibility-consent'],
  'consent-required': [400, 'plugin-consent-required'],
  'preview-expired': [409, 'plugin-preview-expired'],
  'version-conflict': [409, 'plugin-version-conflict'],
  'migration-unsupported': [409, 'plugin-migration-unsupported'],
  'operation-pending': [409, 'plugin-operation-pending'],
  'integrity-failed': [409, 'plugin-integrity-failed'],
  'reinstall-required': [409, 'plugin-reinstall-required'],
  'not-installed': [404, 'plugin-not-installed'],
  'page-not-found': [404, 'plugin-not-installed'],
  'no-rollback': [409, 'plugin-rollback-unavailable'],
  'rollback-unavailable': [409, 'plugin-rollback-unavailable'],
  disabled: [409, 'plugin-disabled'],
  'python-dependencies': [422, 'plugin-python-dependencies'],
  'runtime-forbidden': [403, 'plugin-runtime-forbidden'],
  'runtime-input': [400, 'plugin-runtime-input'],
  'runtime-busy': [409, 'plugin-runtime-busy'],
};

async function upload(request: IncomingMessage) {
  if (header(request, 'content-type') !== 'application/octet-stream' || header(request, 'content-encoding')) {
    throw new HttpError(415, 'plugin-invalid-package');
  }
  const length = Number(header(request, 'content-length'));
  if (!Number.isSafeInteger(length) || length < 22 || length > archiveLimit) throw new HttpError(413, 'plugin-invalid-package');
  const bytes = Buffer.alloc(length);
  let offset = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    if (offset + chunk.length > length) throw new HttpError(413, 'plugin-invalid-package');
    chunk.copy(bytes, offset);
    offset += chunk.length;
  }
  if (offset !== length) throw new HttpError(400, 'plugin-invalid-package');
  return bytes;
}

export async function servePlugins(registry: PluginRegistry, runtime: PluginRuntime, path: string, request: IncomingMessage, response: ServerResponse,
  owner: string, body: () => Promise<Record<string, unknown>>) {
  const get = request.method === 'GET';
  let runtimeRoute = false;
  try {
    if (path === '/api/plugins' && get) {
      send(response, 200, registry.list());
      return;
    }
    if (path === '/api/plugins/preview' && !get) {
      send(response, 200, registry.preview(await upload(request), owner));
      return;
    }
    if (path === '/api/plugins/install' && !get) {
      const input = await body();
      if (Object.keys(input).some((key) => !['token', 'consent', 'allowIncompatible'].includes(key)) ||
        typeof input.token !== 'string' || input.token.length > 36 || typeof input.consent !== 'boolean' ||
        input.allowIncompatible !== undefined && typeof input.allowIncompatible !== 'boolean') throw new HttpError(400, 'plugin-consent-required');
      registry.install(input.token, input.consent, input.allowIncompatible === true, owner);
      send(response, 200, { plugins: registry.list() });
      return;
    }
    const [, , , id, action, page, digest, ...extra] = path.split('/');
    if (!id || !pluginID.test(id) || extra.length) throw new HttpError(404, 'plugin-not-installed');
    if (get && action === 'pages' && page && digest) {
      send(response, 200, runtime.page(id, page, digest, owner));
      return;
    }
    if (action === 'runtime') {
      runtimeRoute = true;
      const grant = runtime.authorize(id, owner, header(request, 'x-oep-plugin'));
      if (get && page === 'events' && digest) runtime.stream(grant, digest, response);
      else if (get && page === 'panels' && digest) send(response, 200, runtime.panel(grant, digest));
      else if (!get && page === 'sources' && digest === undefined) {
        const length = Number(header(request, 'content-length'));
        const file = header(request, 'x-oep-filename');
        if (header(request, 'content-type') !== 'application/octet-stream' || header(request, 'content-encoding') ||
          !Number.isSafeInteger(length) || length < 1 || length > sourceLimit || !file || file.length > 2400) {
          throw new HttpError(400, 'plugin-runtime-input');
        }
        const bytes = Buffer.alloc(length);
        let at = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
          if (at + chunk.length > length) throw new HttpError(400, 'plugin-runtime-input');
          at += chunk.copy(bytes, at);
        }
        if (at !== length) throw new HttpError(400, 'plugin-runtime-input');
        send(response, 201, runtime.addSource(grant, decodeURIComponent(file), bytes));
      } else if (!get && page === undefined) {
        const { method, params = {}, ...rest } = await body();
        if (typeof method !== 'string' || !/^[a-z]+\.[a-z]+$/.test(method) || Object.keys(rest).length ||
          !params || typeof params !== 'object' || Array.isArray(params)) throw new HttpError(400, 'plugin-runtime-input');
        send(response, 200, await runtime.call(grant, method, params as Record<string, unknown>));
      } else throw new HttpError(404, 'plugin-not-installed');
      return;
    }
    if (!get && page === undefined && ['enable', 'disable', 'rollback', 'uninstall', 'trust-current'].includes(action)) {
      const input = await body();
      if (Object.keys(input).some((key) => key !== 'allowIncompatible') ||
          input.allowIncompatible !== undefined && typeof input.allowIncompatible !== 'boolean') throw new HttpError(400, 'plugin-invalid-package');
      const cleanup = action === 'uninstall' ? registry.uninstall(id) : undefined;
      const preview = action === 'trust-current' ? registry.trustCurrent(id, owner) : undefined;
      if (action === 'enable') registry.enable(id, input.allowIncompatible === true);
      if (action === 'disable') registry.disable(id);
      if (action === 'rollback') registry.rollback(id, input.allowIncompatible === true);
      send(response, 200, { plugins: registry.list(), preview, ...cleanup });
      return;
    }
    throw new HttpError(404, 'plugin-not-installed');
  } catch (error) {
    if (error instanceof PluginError && Object.hasOwn(errors, error.code)) throw new HttpError(...errors[error.code]);
    if (runtimeRoute && !(error instanceof HttpError)) throw new HttpError(422, 'plugin-runtime-failed');
    throw error;
  }
}
