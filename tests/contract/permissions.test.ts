import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeClient, SessionCreateInput } from '@opencode/client';
import { createSession } from '../../apps/adapter/src/opencode/sessions.ts';

test('Session setup binds a fixed location, agent, relay alias and least permissions', async () => {
  const seen: SessionCreateInput[] = [];
  const client = {
    session: { create: async (input: SessionCreateInput) => {
      seen.push(input);
      return { ...input, id: `session-${seen.length}` };
    } },
  } as unknown as OpenCodeClient;
  const [writer, inspector] = await Promise.all([
    createSession(client, 'workspace-a', 'workbook', 'contract-model'),
    createSession(client, 'workspace-b', 'inspector', 'contract-model'),
  ]);
  assert.notEqual(writer, inspector);
  assert.equal(seen[0].location?.directory, 'workspace-a');
  assert.equal(seen[1].location?.directory, 'workspace-b');
  assert.deepEqual(seen[0].permissions?.filter((rule) => rule.action === 'edit'),
    [{ action: 'edit', resource: 'program.js', effect: 'allow' }]);
  assert.ok(seen[1].permissions?.every((rule) => rule.action === 'read'));
  assert.ok(seen.every((entry) => entry.model?.providerID === 'oep-relay' && entry.model.id === 'contract-model'));
});
