let csrf;

export function modelLabel(alias) {
  return alias.startsWith('synthetic-') ? '測試模型' : alias;
}

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body, signal });
  const result = await response.json();
  if (!response.ok) throw new RequestError(response.status, result.error || 'OEP 無法完成要求。');
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
