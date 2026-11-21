import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyCitations } from '../../packages/contracts/src/evidence.ts';

const text = 'Synthetic reading equals 1.25 V.';
const passage = { id: 'p1', source: 'fixture', locator: 'row:1', text, sha256: createHash('sha256').update(text).digest('hex') };
const input = { question: 'What is the reading?', revision: 'fixture-v1', passages: [passage] };
const citation = { passageID: passage.id, source: passage.source, locator: passage.locator, sha256: passage.sha256, quote: '1.25 V' };

test('Accept an exact quote with fixed provenance', () => {
  assert.deepEqual(verifyCitations(input, [citation]), { state: 'verified', revision: input.revision, citations: [citation] });
});

test('Abstain when the pinned evidence is missing', () => {
  assert.deepEqual(verifyCitations({ ...input, passages: [] }, [citation]), { state: 'abstain', reason: 'no-evidence' });
  assert.deepEqual(verifyCitations(input, []), { state: 'abstain', reason: 'no-evidence' });
});

test('Reject changed evidence and fabricated locations, units, and quotes', () => {
  for (const proposal of [{ ...citation, locator: 'row:2' }, { ...citation, quote: '1.25 mV' }, { ...citation, passageID: 'unknown' }]) {
    assert.deepEqual(verifyCitations(input, [proposal]), { state: 'error', reason: 'invalid-citation' });
  }
  assert.deepEqual(verifyCitations({ ...input, passages: [{ ...passage, text: `${text} Edited.` }] }, [citation]),
    { state: 'error', reason: 'invalid-citation' });
});
