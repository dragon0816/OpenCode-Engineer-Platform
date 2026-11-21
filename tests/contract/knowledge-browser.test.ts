import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { canonical } from '../../packages/knowledge/src/snapshot.ts';
import { largeKnowledgeFixture } from '../fixtures/knowledge/large.ts';

test('browse 1,500 synthetic cards and indexed passages within 200 ms', (context) => {
  const snapshot = largeKnowledgeFixture();
  const store = new KnowledgeStore(':memory:');
  try {
    const vault = snapshot.vault.id;
    store.import(snapshot, Buffer.from(canonical(snapshot)));
    for (const [name, query] of [
      ['list', { offset: 1475, descending: true }],
      ['filter', { type: 'odd', domain: 'Lab', sample: 'sample' }],
      ['FTS', { query: 'calibration' }],
    ] as const) {
      const times = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const start = performance.now();
        const result = store.browse(vault, query);
        times.push(performance.now() - start);
        assert.ok(result);
        if ('cards' in result) {
          assert.equal(result.total, name === 'list' ? 1500 : 750);
          assert.equal(result.cards.length, 25);
          assert.equal(result.cards[0]?.id, name === 'list' ? 'card-24' : 'card-1');
        } else assert.equal(result.passages.length, 25);
      }
      // A shared CI runner can stall one sample, so judge typical latency by the median and keep a loose
      // catastrophic bound on the slowest sample instead of failing on a single scheduler hiccup.
      const sorted = [...times].sort((left, right) => left - right);
      const median = sorted[Math.floor(sorted.length / 2)];
      const slowest = sorted[sorted.length - 1];
      context.diagnostic(name + ' median ' + median.toFixed(2) + ' ms, max ' + slowest.toFixed(2) + ' ms');
      assert.ok(median < 200, name + ' median exceeded 200 ms');
      assert.ok(slowest < 1000, name + ' slowest sample exceeded 1000 ms');
    }
    const detail = store.browse(vault, { card: 'card-0' });
    assert.ok(detail && 'card' in detail);
    assert.equal(detail.related[0]?.toTitle, 'Sample 1');
    assert.equal(detail.passages[0]?.text, 'Synthetic calibration passage 0');
    assert.equal(detail.history, undefined);
    assert.equal(store.rebuild(), 1);
    assert.equal(store.rebuild(), 1);
  } finally { store.close(); }
});
