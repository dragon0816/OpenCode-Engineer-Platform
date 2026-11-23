// Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/vault.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
import { biEvidenceLocator, readBiSnapshot, stableBiId } from '../../../../packages/knowledge/src/repository-bi.ts';
import { RepositoryFolder, RepositoryError } from '../../../../packages/knowledge/src/repository-files.ts';
import { canonical, identifier, record, rows, sha256, snapshotFormat, string, validateSnapshot } from '../../../../packages/knowledge/src/snapshot.ts';
import type { Card, Snapshot, Source } from '../../../../packages/knowledge/src/snapshot.ts';
import type { documentWorker } from './document-worker.ts';

type Replay = { units: Record<string, unknown>; clock: number; digest: string; commits: number; conflicts: number };
const sequence = /^([1-9][0-9]{0,8})\.json$/;
const author = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const commitLimit = 8 * 1024 * 1024;
export const workingRepositoryLimit = 24 * 1024 * 1024;

function project({ units, clock, digest, commits, conflicts }: Replay, vault: Snapshot['vault']) {
  const reference = typeof units.schema === 'string' ? units.schema : typeof units.schema === 'object' && units.schema
    ? (units.schema as { ref?: unknown }).ref : undefined;
  const raw = typeof reference === 'string' ? reference : '';
  const separator = raw.lastIndexOf('@');
  const schemaId = raw.slice(0, separator);
  const document = { schemaReference: reference ?? null, source: 'aep-working-copy' };
  const repository: NonNullable<Snapshot['repository']> = { tag: 'working-copy', commit: digest, clock,
    author: 'local-import', seq: Math.max(1, commits), history: [], evidence: [], relationEvidence: [] };
  const snapshot: Snapshot = { format: snapshotFormat, status: 'published', vault, repository,
    publication: { revision: 'working-' + digest, publishedAt: new Date(0).toISOString(), publisher: 'local-import' },
    schema: { id: identifier.test(schemaId) ? schemaId : 'aep-bi-working', version: separator > 0 ? raw.slice(separator + 1) : '1',
      document, sha256: sha256(canonical(document)) }, cards: [], relationships: [], sources: [], passages: [] };
  const cards = new Map<string, Card>();
  const sources = new Map<string, Source>();
  const edges = new Map<string, Snapshot['relationships'][number]>();
  for (const [unit, raw] of Object.entries(units)) {
    if (!unit.startsWith('card:')) continue;
    const item = record(raw, 'card');
    const id = unit.slice(5);
    const card: Card = { id: stableBiId(id, 'card'), key: string(item.key, 'card.key'), type: string(item.type, 'card.type'),
      title: string(item.name, 'card.name'), version: '1', fields: Object.create(null),
      fieldProvenance: Object.create(null), fieldStates: Object.create(null) };
    cards.set(id, card);
  }
  const addLink = (from: Card, to: Card, kind: string, provenance: Record<string, unknown>) => {
    edges.set(canonical([from.id, to.id, kind]), { from: from.id, to: to.id, kind, provenance });
  };
  for (const [unit, raw] of Object.entries(units)) {
    const [kind, id, ...parts] = unit.split(':');
    const field = parts.join(':');
    const card = cards.get(id);
    if (kind === 'field' && card && field) {
      const value = record(raw, 'field');
      if (value.value !== null && value.value !== undefined) {
        card.fields[field] = value.value;
        if (value.source) card.fieldProvenance![field] = value.source;
        for (const link of Array.isArray(value.value) ? value.value : [value.value]) {
          const to = link && typeof link === 'object' && cards.get(String(link.card));
          if (to) addLink(card, to, field, { sourceField: field });
        }
      }
      if (value.history) repository.history!.push({ cardId: card.id, field, ...record(value.history, 'history') });
    } else if (kind === 'state' && card && field) card.fieldStates![field] = record(raw, 'state');
    else if (kind === 'evidence' && card && field) {
      for (const [index, item] of rows(raw, 'evidence').entries()) {
        const { excerpt, ...provenance } = record(item, 'evidence');
        const sequence = sha256(canonical([unit, index]));
        const { label, version } = biEvidenceLocator(JSON.stringify(provenance.locator ?? ''), sequence);
        const source = typeof provenance.source_name === 'string' && provenance.source_name.trim() ? provenance.source_name :
          typeof provenance.source_id === 'string' && provenance.source_id.trim() ? provenance.source_id : 'AEP evidence';
        const sourceId = 'source-' + sha256(canonical([provenance.source_id ?? '', source, version ?? digest]));
        sources.set(sourceId, { id: sourceId, ref: source, version: version ?? digest });
        const passageIds = [];
        if (typeof excerpt === 'string' && excerpt.trim() && provenance.basis !== 'inference') {
          for (let at = 0; at < excerpt.length;) {
            let end = Math.min(at + 4000, excerpt.length);
            if (!excerpt.slice(at, end).isWellFormed() && end < excerpt.length) end--;
            const text = excerpt.slice(at, end);
            if (text.trim()) {
              const id = `evidence-${sequence}-${at}`;
              snapshot.passages.push({ id, sourceId, cardId: card.id, locator: label, text, sha256: sha256(text) });
              passageIds.push(id);
            }
            at = end;
          }
        }
        repository.evidence!.push({ ...provenance, card_id: card.id, field, sourceId, passageIds });
      }
    }
  }
  for (const [unit, raw] of Object.entries(units)) {
    if (unit.startsWith('relation:')) {
      const { from, to, type, ...data } = record(raw, 'relation');
      const first = cards.get(String(from));
      const second = cards.get(String(to));
      if (first && second) addLink(first, second, string(type, 'relation.type'), data);
    } else if (unit.startsWith('relation_evidence:')) repository.relationEvidence!.push(record(raw, 'relation evidence'));
  }
  snapshot.cards = [...cards.values()];
  snapshot.sources = [...sources.values()];
  snapshot.relationships = [...edges.values()];
  return { snapshot: validateSnapshot(snapshot), conflicts };
}

export async function readWorkingRepository(path: string, destination: string, worker: typeof documentWorker, signal: AbortSignal) {
  const folder = new RepositoryFolder(path);
  if (folder.contains(destination)) throw new RepositoryError('.', 'BI workspace must be outside the source repository.');
  const meta = folder.json('repo.json');
  if (meta.format !== 'aep.knowledge.repo/v1' || meta.type !== 'bi' || typeof meta.id !== 'string' || !identifier.test(meta.id)) {
    throw new RepositoryError('repo.json', 'Expected a BI repository export.');
  }
  const vault = { id: meta.id, title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : meta.id, kind: 'bi' as const };
  if (folder.list('.').some(entry => entry.name === 'bi.sqlite')) {
    return folder.sqlite('bi.sqlite', (db, _, digest) => ({ conflicts: 0,
      snapshot: readBiSnapshot(db, 'bi.sqlite', { vault,
        publication: { revision: 'working-' + digest, publishedAt: new Date(0).toISOString(), publisher: 'local-import' },
        repository: { tag: 'working-copy', commit: digest, author: 'local-import', seq: 1, clock: 0 } }) }));
  }
  let size = 0;
  function load(name: string) {
    signal.throwIfAborted();
    const raw = folder.utf8(name, Math.min(commitLimit, workingRepositoryLimit - size));
    size += Buffer.byteLength(raw);
    return raw;
  }
  function commitsAt(directory: string) {
    return folder.list(directory, true).filter(entry => sequence.test(entry.name)).map(({ name }) =>
      [Number(sequence.exec(name)![1]), load(directory + '/' + name)] as const);
  }
  const commits = folder.list('commits', true).filter(entry => author.test(entry.name)).flatMap(({ name }) =>
    commitsAt('commits/' + name).map(([seq, raw]) => [name, seq, raw]));
  const local = commitsAt('work/commits');
  const pending = folder.list('work', true).some(entry => entry.name === 'pending.json') ? load('work/pending.json') : null;
  const input = Buffer.from(JSON.stringify({ repository: vault.id, commits, local, pending }));
  if (input.length > workingRepositoryLimit) throw new RepositoryError('.', 'Working export exceeds the supported replay size.');
  return project(await worker<Replay>(['worktree'], input, signal), vault);
}
