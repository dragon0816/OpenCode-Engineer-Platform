import type { OpenCodeClient, SessionPromptInput } from '@opencode/client';
import { randomBytes } from 'node:crypto';
import { call } from './client.ts';
import { providerID } from './gateway.ts';
import { submissionCount } from './reconcile.ts';
import { nativeContractPermissions } from './permissions.ts';
import type { Permission } from './permissions.ts';

export type Agent = 'workbook' | 'inspector';
export const promptID = () => `msg_${randomBytes(16).toString('hex')}`;

export async function createSession(client: OpenCodeClient, directory: string, agent: Agent, alias: string, permissions?: Permission[]) {
  const session = await client.session.create({
    title: `OEP ${permissions ? 'Web' : 'synthetic'} ${agent}`, location: { directory }, model: { id: alias, providerID }, agent,
    permissions: permissions ?? nativeContractPermissions(agent === 'workbook'),
  }, call());
  validateSessionProfile(session, directory, agent, alias);
  return session.id;
}

export function validateSessionProfile(session: Awaited<ReturnType<OpenCodeClient['session']['get']>>,
  directory: string, agent: Agent, alias: string) {
  if (session.agent !== agent || session.location?.directory !== directory ||
      session.model?.id !== alias || session.model.providerID !== providerID) {
    throw new Error('Session profile mismatch');
  }
}

export async function submitOnce(client: OpenCodeClient, input: SessionPromptInput & { id: string }) {
  const { sessionID, id } = input;
  try {
    const response = await client.session.prompt(input, call());
    if (response.id === id && response.sessionID === sessionID) return 'accepted' as const;
  } catch {
    // The server might already have committed the admission before the response was lost.
  }
  try {
    const { inbox, messages } = await submissionCount(client, sessionID, id);
    if (messages === 1 || inbox === 1 && messages === 0) return 'reconciled' as const;
  } catch {
    // A later operator can reconcile the preserved upstream identifiers.
  }
  return 'indeterminate' as const;
}

export async function assistantMessages(client: OpenCodeClient, sessionID: string) {
  const messages = await client.message.list({ sessionID, type: 'assistant', order: 'asc' }, call());
  return messages.data.filter((message) => message.type === 'assistant');
}
