import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelSeat } from '../../apps/adapter/src/opencode/model-seat.ts';

test('the shared model seat preserves FIFO order through cancellation and failure', async () => {
  const seat = new ModelSeat();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const web = seat.run(async () => {
    calls.push('Web');
    await release.promise;
    throw new Error('Synthetic provider failure');
  });
  const stop = new AbortController();
  const cancelled = seat.run(async () => { calls.push('cancelled'); }, stop.signal);
  const main = seat.run(async () => { calls.push('Telegram Main'); });
  const bi = seat.run(async () => { calls.push('Telegram BI'); });
  const checkWeb = assert.rejects(web, /Synthetic provider failure/);
  const checkCancelled = assert.rejects(cancelled, { name: 'AbortError' });
  await Promise.resolve();
  assert.deepEqual(calls, ['Web']);
  stop.abort();
  release.resolve();
  await Promise.all([checkWeb, checkCancelled, main, bi]);
  assert.deepEqual(calls, ['Web', 'Telegram Main', 'Telegram BI']);
});
