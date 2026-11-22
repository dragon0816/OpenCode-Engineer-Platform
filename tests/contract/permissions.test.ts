import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeClient, SessionCreateInput } from '@opencode/client';
import { createSession } from '../../apps/adapter/src/opencode/sessions.ts';
import { allowedModelTool, knowledgeTool, sessionPermissions, statusTool } from '../../apps/adapter/src/opencode/permissions.ts';
import { customMcpName } from '../../apps/adapter/src/runs/custom-mcp.ts';
import { workbookInput } from '../../apps/adapter/src/runs/web-workbook.ts';

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
  assert.deepEqual(seen[1].permissions, [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: 'sop.md', effect: 'allow' },
    { action: 'read', resource: 'marker.txt', effect: 'allow' },
  ]);
  assert.ok(seen.every((entry) => entry.model?.providerID === 'oep-relay' && entry.model.id === 'contract-model'));
});

test('the permission builder starts closed and grants only origin-specific access', () => {
  const custom = [{ id: 'a'.repeat(32), deniedTools: ['blocked'] }];
  const workbookRun = '01c4b1fd-2f07-4760-a96c-89eda1f01230';
  const agentID = 'main';
  const policy = { agentID, knowledge: true, status: true, custom, workbookRun };
  const deny = { action: '*', resource: '*', effect: 'deny' };
  const name = customMcpName(custom[0].id);
  const web = sessionPermissions({ ...policy, origin: 'web' });
  assert.deepEqual(web, [deny,
    { action: statusTool, resource: '*', effect: 'allow' },
    { action: knowledgeTool, resource: '*', effect: 'allow' },
    { action: `${name}_*`, resource: '*', effect: 'allow' },
    { action: `${name}_blocked`, resource: '*', effect: 'deny' },
    { action: 'edit', resource: workbookInput(workbookRun), effect: 'allow' },
  ]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'channel' }), web.slice(0, -1));
  assert.deepEqual(sessionPermissions({ agentID, origin: 'web' }), [deny]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'schedule' }), [deny]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'delegation' }), [deny]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'web', agentID: 'specialist' }), web.slice(0, 2));
  for (const denied of ['bash', 'webfetch', 'task', 'read', 'external_directory', `${name}_blocked`]) {
    assert.equal(allowedModelTool(web, denied), false);
  }
});
