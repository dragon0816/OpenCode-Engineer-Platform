import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors.ts';

const randomToken = () => randomBytes(32).toString('hex');
const cookieName = 'oep_session';
const tokenFormat = /^[a-f\d]{64}$/;
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function header(request: IncomingMessage, name: string) {
  const values = request.headersDistinct[name];
  if (values && values.length !== 1) throw new HttpError(400, 'duplicate-header');
  return values?.[0] ?? '';
}

export class LocalAuth {
  private readonly tickets = new Map<string, number>();
  private readonly browsers = new Map<string, string>();
  private readonly origin: string;
  private readonly host: string;

  constructor(port: number) {
    this.host = `127.0.0.1:${port}`;
    this.origin = `http://${this.host}`;
  }

  check(request: IncomingMessage) {
    if (header(request, 'host') !== this.host) throw new HttpError(403, 'unexpected-host');
    const origin = header(request, 'origin');
    const site = header(request, 'sec-fetch-site');
    if (origin && origin !== this.origin || site && site !== 'same-origin' && site !== 'none') {
      throw new HttpError(403, 'unexpected-origin');
    }
    if (request.method === 'POST' && origin !== this.origin) throw new HttpError(403, 'origin-required');
  }

  pairURL() {
    const now = Date.now();
    for (const [key, expiry] of this.tickets) if (expiry <= now) this.tickets.delete(key);
    if (this.tickets.size >= 32) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomToken();
    this.tickets.set(ticket, now + 120_000);
    return `${this.origin}/#pair=${ticket}`;
  }

  private browser(request: IncomingMessage) {
    const entries = header(request, 'cookie').split(';').map((item) => item.trim())
      .filter((item) => item.startsWith(`${cookieName}=`));
    const key = entries.length === 1 ? entries[0].slice(cookieName.length + 1) : '';
    const csrf = this.browsers.get(key);
    return csrf ? { key, csrf } : undefined;
  }

  pair(request: IncomingMessage, response: ServerResponse, ticket: unknown) {
    if (typeof ticket !== 'string' || !tokenFormat.test(ticket)) throw new HttpError(403, 'launch-link-invalid');
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!expires || expires <= Date.now()) throw new HttpError(403, 'launch-link-invalid');
    const existing = this.browser(request);
    const key = existing?.key ?? randomToken();
    const csrf = existing?.csrf ?? randomToken();
    if (!existing && this.browsers.size >= 32) this.browsers.delete(this.browsers.keys().next().value!);
    this.browsers.set(key, csrf);
    response.setHeader('Set-Cookie', `${cookieName}=${key}; Path=/api; HttpOnly; SameSite=Strict`);
    return { csrf };
  }

  authorize(request: IncomingMessage) {
    const session = this.browser(request);
    if (!session) throw new HttpError(401, 'launch-required');
    if (request.method === 'POST') {
      const submitted = header(request, 'x-oep-csrf');
      if (!tokenFormat.test(submitted) || !equal(submitted, session.csrf)) throw new HttpError(403, 'pairing-expired');
    }
    return { csrf: session.csrf };
  }
}
