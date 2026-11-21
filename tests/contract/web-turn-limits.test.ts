import assert from 'node:assert/strict';
import test from 'node:test';
import { countModelTools, limitHistory, parseTurnLimits, turnLimitDefaults, turnMarker } from '../../apps/adapter/src/opencode/turn-limits.ts';

test('web history limits retain the active turn and complete recent tool exchanges', () => {
  const marker = turnMarker('synthetic');
  const messages = [
    { role: 'system', content: 'System instruction' },
    { role: 'user', content: 'Old synthetic question' },
    { role: 'assistant', content: 'Old synthetic answer' },
    { role: 'user', content: 'Recent synthetic question' },
    { role: 'assistant', content: 'Tool call' },
    { role: 'tool', content: 'Tool result' },
    { role: 'assistant', content: 'Recent answer' },
    { role: 'user', content: [{ type: 'text', text: 'Current question' + marker }] },
    { role: 'assistant', content: 'Current tool call' },
    { role: 'tool', content: 'Current tool result' },
  ];
  const recent = [messages[0], ...messages.slice(3)];
  const active = [messages[0], ...messages.slice(7)];
  assert.deepEqual(limitHistory(messages, marker, { ...turnLimitDefaults, recentMessages: 4 }), recent);
  assert.deepEqual(limitHistory(messages, marker, { ...turnLimitDefaults, recentMessages: 3 }), active);
  assert.deepEqual(limitHistory(messages, marker, { ...turnLimitDefaults, historyBytes: 1 }), active);
  assert.equal(limitHistory(messages, turnMarker('other'), turnLimitDefaults), undefined);
  assert.equal(parseTurnLimits({ ...turnLimitDefaults, toolCalls: 1.1 }), undefined);
  assert.equal(parseTurnLimits({ ...turnLimitDefaults, timeoutSeconds: 181 }), undefined);
});

test('web tool budgets count unique streaming calls including parallel calls', () => {
  const chunk = (...indices: number[]) => ({ choices: [{ index: 0, delta: { tool_calls: indices.map((index) => ({ index })) } }] });
  assert.equal(countModelTools([chunk(0), chunk(0, 1), chunk(1)]), 2);
  assert.equal(countModelTools([{ choices: [{ message: { tool_calls: [{}, {}] } }] }]), 2);
});
