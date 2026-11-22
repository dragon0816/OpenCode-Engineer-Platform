import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeClient, SessionCreateInput } from '@opencode/client';
import { createSession } from '../../apps/adapter/src/opencode/sessions.ts';
import { allowedModelTool, knowledgeTool, readFileTool, sessionPermissions, statusTool, writeFileTool } from '../../apps/adapter/src/opencode/permissions.ts';
import { customMcpName } from '../../apps/adapter/src/runs/custom-mcp.ts';

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
  const agentID = 'main';
  const name = customMcpName('a'.repeat(32));
  const policy = { agentID, knowledge: true, status: true, files: true, custom: [`${name}_allowed`] };
  const deny = { action: '*', resource: '*', effect: 'deny' };
  const web = sessionPermissions({ ...policy, origin: 'web' });
  assert.deepEqual(web, [deny,
    { action: statusTool, resource: '*', effect: 'allow' },
    { action: readFileTool, resource: '*', effect: 'allow' },
    { action: writeFileTool, resource: '*', effect: 'allow' },
    { action: knowledgeTool, resource: '*', effect: 'allow' },
    { action: `${name}_allowed`, resource: '*', effect: 'allow' },
  ]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'channel' }), web);
  assert.deepEqual(sessionPermissions({ agentID, origin: 'web' }), [deny]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'schedule' }), [deny]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'delegation' }), [deny]);
  assert.deepEqual(sessionPermissions({ ...policy, origin: 'web', agentID: 'specialist', custom: [] }), web.slice(0, -1));
  for (const origin of ['web', 'channel', 'schedule', 'delegation'] as const) {
    const permissions = sessionPermissions({ ...policy, origin });
    for (const denied of ['bash', 'webfetch', 'task', 'read', 'write', 'edit', 'external_directory', `${name}_blocked`]) {
      assert.equal(allowedModelTool(permissions, denied), false);
    }
  }
});
