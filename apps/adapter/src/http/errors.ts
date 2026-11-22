import { webMessage } from './messages.ts';
import type { WebMessageCode } from './messages.ts';

export class WebMessageError extends Error {
  readonly detail: ReturnType<typeof webMessage>;

  constructor(code: WebMessageCode, params?: Parameters<typeof webMessage>[1]) {
    const detail = webMessage(code, params);
    super(detail.text);
    this.detail = detail;
  }
}

export class HttpError extends WebMessageError {
  readonly status: number;

  constructor(status: number, code: WebMessageCode, params?: Parameters<typeof webMessage>[1]) {
    super(code, params);
    this.status = status;
  }
}
