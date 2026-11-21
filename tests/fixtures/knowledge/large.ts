import { sha256 } from '../../../packages/knowledge/src/snapshot.ts';
import { goldFixture } from './gold.ts';

export function largeKnowledgeFixture() {
  const { snapshot } = goldFixture();
  const source = snapshot.sources[0]!;
  snapshot.vault = { ...snapshot.vault, id: 'synthetic-large', title: '合成卡片資料庫' };
  snapshot.cards = [];
  snapshot.passages = [];
  snapshot.relationships = [{ from: 'card-0', to: 'card-1', kind: 'sample-link' }];
  for (let index = 0; index < 1500; index++) {
    const id = 'card-' + index;
    const text = 'Synthetic calibration passage ' + index;
    snapshot.cards.push({ id, type: index % 2 ? 'odd' : 'even', key: id, title: 'Sample ' + index,
      version: '1', fields: { domain: index % 2 ? 'Lab' : 'Office', sample: true } });
    snapshot.passages.push({ id, cardId: id, sourceId: source.id, locator: 'row-' + index, text, sha256: sha256(text) });
  }
  return snapshot;
}
