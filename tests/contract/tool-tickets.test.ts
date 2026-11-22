import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionPermissions, statusTool } from '../../apps/adapter/src/opencode/permissions.ts';
import { ToolTickets } from '../../apps/adapter/src/opencode/tool-tickets.ts';
import { nonceMarker, stripTransport, transportField } from '../../apps/adapter/src/opencode/tool-transport.ts';

const initial = { agentID: 'agent-a', workspaceID: 'workspace-a', origin: 'web', revision: 4,
  model: 'synthetic-model', name: 'Synthetic agent', workspaceName: 'Synthetic workspace',
  permissions: sessionPermissions({ agentID: 'agent-a', origin: 'web', status: true }) };
const identity = { sessionID: 'session-a', runID: 'run-a', scope: initial };

test('status tickets bind the launch, session, run, tool, call and arguments, and are consumed once', () => {
  const tickets = new ToolTickets();
  const attempt = tickets.begin(identity, new AbortController().signal, () => initial);
  const token = attempt.issue(statusTool, 'call-a', {});
  const args = { [transportField]: token };
  assert.throws(() => tickets.consume(statusTool, { [transportField]: 'oep-ticket-' + '0'.repeat(64) }));
  assert.throws(() => tickets.consume('oep_hidden', args));
  assert.throws(() => attempt.issue(statusTool, 'call-a', {}));
  for (const field of ['role', 'root', 'workspaceRoot', 'context', 'sessionId', 'agent_id', 'credential', 'apiKey', transportField]) {
    assert.throws(() => attempt.issue(statusTool, 'malformed-call', { [field]: 'synthetic' }));
    if (field !== transportField) assert.throws(() => tickets.consume(statusTool, { ...args, [field]: { nested: true } }));
  }
  const grant = tickets.consume(statusTool, args);
  assert.deepEqual(grant.args, {});
  assert.equal(grant.scope.name, initial.name);
  assert.equal(grant.scope.workspaceName, initial.workspaceName);
  assert.throws(() => tickets.consume(statusTool, args));
  const late = { [transportField]: attempt.issue(statusTool, 'late-call', {}) };
  attempt.close();
  assert.throws(() => tickets.consume(statusTool, late));
  assert.throws(() => attempt.issue(statusTool, 'after-end', {}));
  const next = tickets.begin({ ...identity, sessionID: 'session-b', runID: 'run-b' }, new AbortController().signal, () => initial);
  assert.ok(next.nonce !== attempt.nonce);
  assert.throws(() => tickets.consume(statusTool, late));
  next.close();
});

test('expiration, live scope changes, abort and restart invalidate unspent tickets', () => {
  let now = 0;
  const tickets = new ToolTickets(() => now, 10);
  const signal = new AbortController();
  let live = { ...initial };
  const attempt = tickets.begin(identity, signal.signal, () => live);
  const expired = { [transportField]: attempt.issue(statusTool, 'expiring', {}) };
  now = 10;
  assert.throws(() => tickets.consume(statusTool, expired), /expired/);
  const switched = { [transportField]: attempt.issue(statusTool, 'switching', {}) };
  live = { ...initial, workspaceID: 'workspace-b', revision: initial.revision + 1 };
  assert.throws(() => tickets.consume(statusTool, switched), /changed/);
  live = { ...initial };
  assert.throws(() => tickets.consume(statusTool, switched));
  const aborted = tickets.begin(identity, signal.signal, () => live);
  const prior = { [transportField]: aborted.issue(statusTool, 'aborting', {}) };
  signal.abort();
  assert.throws(() => tickets.consume(statusTool, prior));

  const restart = tickets.begin(identity, new AbortController().signal, () => live);
  const beforeRestart = { [transportField]: restart.issue(statusTool, 'restarting', {}) };
  tickets.close();
  assert.throws(() => tickets.consume(statusTool, beforeRestart));
  const relaunched = new ToolTickets();
  const relaunchedAttempt = relaunched.begin(identity, new AbortController().signal, () => live);
  assert.throws(() => relaunched.consume(statusTool, beforeRestart));
  relaunchedAttempt.close();
});

test('transport stripping removes the nonce, schema field, and structured tool arguments', () => {
  const nonce = 'f'.repeat(64);
  const token = 'oep-ticket-' + 'a'.repeat(64);
  assert.deepEqual(stripTransport({ text: 'Synthetic' + nonceMarker(nonce), arguments: JSON.stringify({ [transportField]: token, sample: 1 }),
    parameters: { properties: { [transportField]: {} }, required: [transportField] }, receipt: `Opaque ${token}` }), {
    text: 'Synthetic', arguments: '{"sample":1}', parameters: { properties: {}, required: [] }, receipt: 'Opaque [redacted]',
  });
});
