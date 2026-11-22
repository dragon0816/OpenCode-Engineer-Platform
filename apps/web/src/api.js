let csrf;

export function modelLabel(alias) {
  return alias.startsWith('synthetic-') ? '已設定的模型' : alias;
}

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function errorText(error, fallback = '無法完成操作。請稍後再試。') {
  const message = typeof error === 'string' ? error : error?.message;
  return typeof message === 'string' && /\p{Script=Han}/u.test(message) ? message : fallback;
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
    body = file;
  }
  if (body !== undefined && csrf) headers['X-OEP-CSRF'] = csrf;
  let response;
  let result;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body, signal });
    result = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('無法讀取 OEP 的回覆。請確認服務仍在執行，再試一次。', { cause: error });
  }
  if (!response.ok) throw new RequestError(response.status, errorText(result?.error));
  return result;
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
