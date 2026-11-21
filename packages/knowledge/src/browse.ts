import { identifier, sha256 } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

const collator = new Intl.Collator('zh-Hant', { numeric: true });
const searchable = (value: string) => value.normalize('NFKC').toLowerCase();
const text = (value: unknown) => typeof value === 'string' ? value : '';

export function browseSnapshot(snapshot: Snapshot) {
  const cards = snapshot.cards.map((card) => {
    const { id, title, key, type, version, fields } = card;
    return { id, title, key, type, version,
      category: text(fields.category),
      domain: text(fields.domain ?? fields.application_folder ?? fields.applicationFolder ?? fields.folder ??
        snapshot.schema.document.domain),
      sample: fields.synthetic === true || fields.sample === true || snapshot.schema.document.synthetic === true };
  });
  const byId = new Map(snapshot.cards.map((card) => [card.id, card]));
  const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
  const passages = new Map(snapshot.passages.map((passage) => [passage.id, passage]));
  const describePassage = (id: string) => {
    const passage = passages.get(id);
    return passage && { ...passage, source: sources.get(passage.sourceId)?.ref };
  };
  const choices = (values: string[]) => [...new Set(values.filter(Boolean))].sort(collator.compare);
  const types = choices(cards.map((card) => card.type));
  const categories = choices(cards.map((card) => card.category));
  const domains = choices(cards.map((card) => card.domain));
  const tables = snapshot.schema.document.tables;
  const history = tables && typeof tables === 'object' && !Object.hasOwn(tables, 'history') ? undefined : snapshot.repository?.history;
  return {
    describePassage,
    list(input: Record<string, unknown>) {
      const term = searchable(text(input.text));
      const sort = input.sort;
      const column = sort === 'type' || sort === 'key' || sort === 'version' || sort === 'domain' || sort === 'category'
        ? sort : 'title';
      const offset = typeof input.offset === 'number' && Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
      const matches = cards.filter((card) =>
        (!input.type || card.type === input.type) && (!input.category || card.category === input.category) &&
        (!input.domain || card.domain === input.domain) &&
        (!input.sample || card.sample === (input.sample === 'sample')) &&
        (!term || searchable([card.title, card.key, card.type, card.domain, card.category].join(' ')).includes(term)));
      const direction = input.descending === true ? -1 : 1;
      matches.sort((a, b) => direction * collator.compare(a[column], b[column]) || collator.compare(a.id, b.id));
      return { total: matches.length, offset, cards: matches.slice(offset, offset + 25),
        types, categories, domains };
    },
    detail(id: string) {
      const card = byId.get(id);
      if (!card) return undefined;
      const related = snapshot.relationships.filter(({ from, to }) => from === id || to === id).map((relation) => ({
        ...relation, fromTitle: byId.get(relation.from)?.title, toTitle: byId.get(relation.to)?.title,
      }));
      return { card, related, passages: snapshot.passages.filter(({ cardId }) => cardId === id).map(({ id }) => describePassage(id)),
        history: history?.filter((row) => {
          const cardId = row.card_id ?? row.cardId;
          return typeof cardId === 'string' && (identifier.test(cardId) ? cardId : 'card-' + sha256(cardId)) === id;
        }),
        evidence: snapshot.repository?.evidence?.filter((row) => Array.isArray(row.passageIds) &&
          row.passageIds.some((passage: string) => passages.get(passage)?.cardId === id)) };
    },
  };
}
