import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeClient } from '@opencode/client';
import { submitOnce } from '../../apps/adapter/src/opencode/sessions.ts';

test('Reconcile a lost admission response without submitting a second time', async () => {
  let posts = 0;
  const input = { id: 'msg_test', sessionID: 'ses_test', text: 'Synthetic' };
  const client = {
    session: {
      prompt: async () => { posts++; throw new Error('lost response'); },
      inbox: { list: async () => [] },
    },
    message: { list: async () => ({ data: [{ id: input.id, type: 'user' }] }) },
  } as unknown as OpenCodeClient;
  assert.equal(await submitOnce(client, input), 'reconciled');
  assert.equal(posts, 1);
  client.message.list = async () => ({ data: [], cursor: {} });
  assert.equal(await submitOnce(client, input), 'indeterminate');
  assert.equal(posts, 2);
});
