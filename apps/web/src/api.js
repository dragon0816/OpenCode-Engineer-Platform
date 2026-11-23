import { getLocale, hasMessage, joinText, LocalizedError, message, resolveText } from './i18n.js';
let csrf;

export const sampleKnowledgeID = 'oep-synthetic-demo';

export function projectLabel(project) {
  const names = { default: message('api.primary-workspace'), secondary: message('api.separate-workspace') };
  return names[project.id] ?? project.title;
}

export class RequestError extends LocalizedError {
  constructor(status, text, detail) {
    super(text);
    this.status = status;
    this.detail = detail;
  }
}

export function serverText(detail, fallback) {
  const key = 'server.' + detail?.code;
  return hasMessage(key) ? message(key, detail.params) : errorText(detail?.text, fallback);
}

export function errorText(error, fallback = message('api.could-not-complete-the-operation-try-again')) {
  if (typeof error === 'function') return error;
  if (error instanceof LocalizedError) return error.localizedText;
  const text = typeof error === 'string' ? error : error?.message;
  return typeof text === 'string' && /\p{Script=Han}/u.test(text) ? () => getLocale() === 'zh-TW' ? text : resolveText(fallback) : fallback;
}

export async function request(path, { data, file, bytes, sha256, signal } = {}) {
  const headers = {};
  let body;
  if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(data);
  } else if (bytes) {
    headers['Content-Type'] = 'application/octet-stream';
    headers['X-OEP-SHA256'] = sha256;
    body = bytes;
  } else if (file) {
    headers['Content-Type'] = file.type || 'application/octet-stream';
    headers['X-OEP-Filename'] = encodeURIComponent(file.name);
    body = file.content;
  }
  if (csrf && (body !== undefined || /^\/api\/agents(?:\/|$)/.test(path) ||
      ['/api/settings/channels', '/api/settings/delegation-budgets'].includes(path))) headers['X-OEP-CSRF'] = csrf;
  let response;
  let result;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body, signal });
    result = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new LocalizedError(message('api.could-not-read-the-oep-response-make'), { cause: error });
  }
  if (!response.ok) {
    const text = result?.errorDetail
      ? serverText(result.errorDetail) : errorText(result?.error);
    throw new RequestError(response.status, result?.errorPath ? joinText([result.errorPath, text]) : text, result?.errorDetail);
  }
  return result;
}

export async function uploadAttachment(sessionPath, file) {
  const report = (code) => request(sessionPath + '/attachment-diagnostics', {
    data: { code }, signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  if (!file.name.isWellFormed()) throw new LocalizedError(message('server.filename-invalid'));
  let content;
  try { content = await file.arrayBuffer(); }
  catch (error) {
    if (error instanceof DOMException && ['NotFoundError', 'NotReadableError', 'SecurityError'].includes(error.name)) {
      void report('upload-client-file-read');
      throw new LocalizedError(message('api.upload-file-unreadable'));
    }
    void report('upload-client-unexpected');
    throw new LocalizedError(message('server.unavailable'));
  }
  try {
    const result = await request(sessionPath + '/attachments', { file: { name: file.name, type: file.type, content } });
    if (typeof result?.id !== 'string') throw new LocalizedError(message('api.could-not-read-the-oep-response-make'));
    return result;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error instanceof LocalizedError) {
      void report('upload-client-response');
      throw error;
    }
    void report('upload-client-unexpected');
    throw new LocalizedError(message('server.unavailable'));
  }
}

export async function connect() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (location.hash) history.replaceState(null, '', '/');
  if (ticket) {
    try { await request('/api/pair', { data: { ticket } }); }
    catch (error) { if (!(error instanceof RequestError) || error.status !== 403) throw error; }
  }
  const bootstrap = await request('/api/bootstrap');
  csrf = bootstrap.csrf;
  return bootstrap;
}
