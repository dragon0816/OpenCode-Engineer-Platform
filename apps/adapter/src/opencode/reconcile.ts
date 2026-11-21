import type { OpenCodeClient } from '@opencode/client';
import { sse, until } from '../../../../scripts/phase0/probe-http.ts';
import { call } from './client.ts';
import type { Endpoint } from './client.ts';

export async function submissionCount(client: OpenCodeClient, sessionID: string, id: string) {
  const [inbox, messages] = await Promise.all([
    client.session.inbox.list({ sessionID }, call()),
    client.message.list({ sessionID, type: 'user' }, call()),
  ]);
  return {
    inbox: inbox.filter((entry) => entry.id === id && entry.type === 'user').length,
    messages: messages.data.filter((message) => message.id === id && message.type === 'user').length,
  };
}

export async function waitForOutcome(client: OpenCodeClient, sessionID: string,
  onActivity?: (state: 'running' | 'awaiting_permission') => void, timeout = 105_000, stop?: AbortSignal,
  submissionID?: string) {
  let delivered = !submissionID;
  return until(async (deadline) => {
    const signal = stop ? AbortSignal.any([deadline, stop]) : deadline;
    const permission = await client.permission.list({ sessionID }, { signal });
    if (permission.length) {
      onActivity?.('awaiting_permission');
      for (const request of permission) await client.permission.reply({ sessionID, requestID: request.id, decision: 'reject' }, { signal });
      onActivity?.('running');
    }
    if (!delivered && submissionID) {
      const { inbox, messages } = await submissionCount(client, sessionID, submissionID);
      if (inbox || messages !== 1) return;
      delivered = true;
    }
    const found = await client.session.get({ sessionID }, { signal });
    if (!found.outcome || (await client.session.active({ signal }))[sessionID]) return;
    return found.outcome;
  }, timeout);
}

export async function* sessionEvents(endpoint: Endpoint, sessionID: string, signal: AbortSignal) {
  const response = await endpoint.request('/api/event', signal);
  if (!response.ok || !response.body) throw new Error('Event subscription failed');
  for await (const frame of sse(response.body, signal)) {
    const event = JSON.parse(frame) as { type: string; data?: { sessionID?: string } };
    if (event.type === 'server.connected' || event.data?.sessionID === sessionID) yield event.type;
  }
}
