import { readFileSync } from 'node:fs';
import { canonical, sha256, snapshotFormat } from '../../../packages/knowledge/src/snapshot.ts';
import type { Snapshot } from '../../../packages/knowledge/src/snapshot.ts';

type FixturePassage = { id: string; revision: string; locator: string; text: string };
export type GoldQuestion = { id: string; class: 'answerable' | 'no-evidence' | 'conflict' | 'injection'; query: string;
  evidence: string[]; answer: string | null };

export function goldFixture() {
  const baseline = readFileSync(new URL('./gold.v1.json', import.meta.url));
  const extension = readFileSync(new URL('./gold.v2.json', import.meta.url));
  const base = JSON.parse(baseline.toString('utf8')) as { version: string; passages: FixturePassage[]; questions: GoldQuestion[] };
  const extra = JSON.parse(extension.toString('utf8')) as { base: string; version: string; additionalPassages: FixturePassage[] };
  if (base.version !== extra.base) throw new Error('Gold set base version mismatch');
  const document = { fields: ['text'] };
  const snapshot: Snapshot = {
    format: snapshotFormat, status: 'published', vault: { id: 'synthetic-bench', kind: 'bi', title: 'Synthetic Bench' },
    publication: { revision: extra.version, publishedAt: '2026-01-01T00:00:00Z', publisher: 'synthetic' },
    schema: { id: 'synthetic', version: '1', document, sha256: sha256(canonical(document)) },
    sources: [], cards: [], relationships: [], passages: [],
  };
  const passages = [...base.passages, ...extra.additionalPassages];
  for (const passage of passages) {
    const sourceId = `source-${passage.id}`;
    snapshot.sources.push({ id: sourceId, ref: passage.locator.split('#')[0], version: passage.revision });
    snapshot.cards.push({ id: passage.id, type: 'fixture', key: passage.id, title: passage.id, version: passage.revision, fields: {} });
    snapshot.passages.push({ id: passage.id, sourceId, cardId: passage.id, locator: passage.locator,
      text: passage.text, sha256: sha256(passage.text) });
  }
  return { snapshot, questions: base.questions, baseline, extension,
    extendedBaseline: Buffer.from(JSON.stringify({ version: extra.version, passages, questions: base.questions })) };
}
