// Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/host/bi_cards_tools.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
import { browseSnapshot } from '../browse.ts';
import { identifier, type Snapshot } from '../snapshot.ts';

export type BiQuery = { vault: string; text?: string; type?: string; domain?: string; category?: string;
  card?: string; from?: string; relation?: string; offset?: number };

export function parseBiQuery(input: Record<string, unknown>): BiQuery | undefined {
  if (typeof input.vault !== 'string' || !identifier.test(input.vault)) return;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'vault') continue;
    if (key === 'offset') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100_000) return;
    } else if (key === 'card' || key === 'from') {
      if (typeof value !== 'string' || !identifier.test(value)) return;
    } else if (!['text', 'type', 'domain', 'category', 'relation'].includes(key) || typeof value !== 'string' ||
        !value.trim() || value.length > 300 || !value.isWellFormed()) return;
  }
  if (input.relation && !input.from || input.card && Object.keys(input).length !== 2 || input.from &&
      Object.keys(input).some(key => !['vault', 'from', 'relation', 'offset'].includes(key))) return;
  return input as BiQuery;
}

export function queryBi(snapshot: Snapshot, input: BiQuery) {
  const view = browseSnapshot(snapshot);
  if (input.card) {
    const detail = view.detail(input.card);
    if (!detail) return { state: 'abstain', reason: 'card-unavailable' };
    const { id, title, type, key, fields, fieldStates } = detail.card;
    const shown = Object.fromEntries(Object.entries(fields).slice(0, 40).filter(([, value]) => JSON.stringify(value).length <= 1000));
    return { state: 'card', card: { id, title, type, key, fields: shown, fieldStates },
      related: detail.related.slice(0, 25).map(({ from, to, kind, fromTitle, toTitle }) => ({ from, to, kind, fromTitle, toTitle })),
      citations: detail.passages.slice(0, 8).flatMap(passage => passage?.source ? [{ passageID: passage.id, source: passage.source,
        locator: passage.locator, quote: passage.text.slice(0, 700).toWellFormed(), sha256: passage.sha256 }] : []) };
  }
  if (input.from) {
    const detail = view.detail(input.from);
    if (!detail) return { state: 'abstain', reason: 'card-unavailable' };
    const matches = detail.related.filter(edge => !input.relation || edge.kind === input.relation);
    const offset = input.offset ?? 0;
    return { state: 'links', total: matches.length, offset, links: matches.slice(offset, offset + 25).map(edge => ({ kind: edge.kind,
      direction: edge.from === input.from ? 'out' : 'in', card: edge.from === input.from ? edge.to : edge.from,
      title: edge.from === input.from ? edge.toTitle : edge.fromTitle })) };
  }
  return { state: 'cards', ...view.list(input) };
}
