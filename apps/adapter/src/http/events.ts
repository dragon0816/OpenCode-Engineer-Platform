import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { sse } from '../../../../scripts/phase0/probe-http.ts';
import type { Endpoint } from '../opencode/client.ts';

const activity = new Map([
  ['session.execution.started', 'working'], ['session.execution.succeeded', 'refresh'],
  ['session.execution.failed', 'refresh'], ['session.execution.interrupted', 'refresh'],
  ['session.step.first-token', 'responding'], ['session.text.delta', 'refresh'], ['session.text.ended', 'refresh'],
  ['session.tool.input.started', 'tool-started'], ['session.tool.called', 'tool-running'],
  ['session.tool.success', 'tool-completed'], ['session.tool.failed', 'tool-failed'],
  ['session.retry.scheduled', 'recovering'], ['permission.asked', 'permission'],
  ['session.message.content.updated', 'refresh'],
]);

const toolNames = new Set(['write', 'edit', 'read']);

export class WebEvents {
  private readonly subscribers = new Map<ServerResponse, string>();
  private readonly stop = new AbortController();
  private readonly work: Promise<void>;
  private readonly heartbeats: NodeJS.Timeout;

  constructor(upstream: Endpoint, publicSessionID: (upstream: string) => string | undefined) {
    this.heartbeats = setInterval(() => {
      for (const response of this.subscribers.keys()) this.write(response, ': heartbeat\n\n');
    }, 10_000);
    this.heartbeats.unref();
    this.work = this.subscribe(upstream, publicSessionID);
  }

  private write(response: ServerResponse, frame: string) {
    if (response.destroyed || response.writableEnded) return;
    if (!response.write(frame)) response.destroy();
  }

  add(response: ServerResponse, sessionID: string) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
    this.subscribers.set(response, sessionID);
    response.once('close', () => this.subscribers.delete(response));
    this.write(response, 'retry: 500\nevent: activity\ndata: {"kind":"refresh"}\n\n');
  }

  notify(sessionID?: string, kind = 'refresh', tool?: string) {
    const frame = `event: activity\ndata: ${JSON.stringify({ kind, tool })}\n\n`;
    for (const [response, id] of this.subscribers) {
      if (!sessionID || id === sessionID) this.write(response, frame);
    }
  }

  async close() {
    this.stop.abort();
    clearInterval(this.heartbeats);
    for (const response of this.subscribers.keys()) response.end();
    await this.work;
  }

  private async subscribe(upstream: Endpoint, publicSessionID: (upstream: string) => string | undefined) {
    const { signal } = this.stop;
    while (!signal.aborted) {
      const connect = new AbortController();
      const connection = AbortSignal.any([signal, connect.signal]);
      const deadline = setTimeout(() => connect.abort(), 4_000);
      try {
        const response = await upstream.request('/api/event', connection);
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error('Upstream event subscription failed');
        }
        for await (const frame of sse(response.body, connection)) {
          const event = JSON.parse(frame) as { type: string; data?: { sessionID?: string; name?: string } };
          if (event.type === 'server.connected') {
            clearTimeout(deadline);
            this.notify();
          }
          const kind = activity.get(event.type);
          const sessionID = event.data?.sessionID && publicSessionID(event.data.sessionID);
          const tool = event.data?.name;
          if (sessionID && kind) this.notify(sessionID, kind, tool && toolNames.has(tool) ? tool : undefined);
        }
      } catch { /* Reconnect and have clients reread the durable projection. */ }
      finally { clearTimeout(deadline); connect.abort(); }
      if (!signal.aborted) this.notify();
      await delay(500, undefined, { signal }).catch(() => undefined);
    }
  }
}
