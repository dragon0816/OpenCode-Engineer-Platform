import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Passage = { id: string; revision: string; locator: string; text: string };
type Question = {
  id: string; class: 'answerable' | 'no-evidence' | 'conflict' | 'injection';
  query: string; evidence: string[]; answer: string | null;
};
type Gold = { version: string; passages: Passage[]; questions: Question[] };
export const fixture = 'tests/fixtures/knowledge/gold.v1.json';

function terms(text: string) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const result = new Set(normalized.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []);
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = Array.from(run);
    for (let i = 0; i < characters.length; i++) {
      result.add(characters[i]);
      if (i + 1 < characters.length) result.add(characters[i] + characters[i + 1]);
    }
  }
  return result;
}

function index(passages: Passage[]) {
  const indexed = passages.map((passage) => ({ id: passage.id, terms: terms(passage.text) }));
  return (query: string) => {
    const queryTerms = terms(query);
    return indexed.map(({ id, terms }) => ({
      id,
      score: [...queryTerms].reduce((score, term) => score + (terms.has(term) ? term.length : 0), 0),
    })).filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 5).map(({ id }) => id);
  };
}

export function evaluate(bytes: Buffer, repetitions = 200) {
  const gold = JSON.parse(bytes.toString('utf8')) as Gold;
  const counts = { answerable: 0, 'no-evidence': 0, conflict: 0, injection: 0 };
  const passages = new Map(gold.passages.map((passage) => [passage.id, passage]));
  const unique = new Set<string>();
  for (const question of gold.questions) {
    if (!(question.class in counts) || unique.has(question.id) ||
        !question.query || question.evidence.some((id) => !passages.has(id))) throw new Error('Invalid fixture labels');
    if (question.class === 'answerable') {
      const citation = question.evidence.map((id) => passages.get(id)!);
      if (!question.answer || !citation.length || !citation.every((passage) => passage.locator && passage.text.includes(question.answer!))) {
        throw new Error('Invalid answer evidence');
      }
    } else if (question.answer !== null || (question.class === 'no-evidence' && question.evidence.length !== 0) ||
        (question.class === 'conflict' && question.evidence.length < 2) || (question.class === 'injection' && !question.evidence.length)) {
      throw new Error('Invalid abstention annotation');
    }
    unique.add(question.id);
    counts[question.class]++;
  }
  if (passages.size !== gold.passages.length || counts.answerable < 24 || counts['no-evidence'] < 20 ||
      counts.conflict + counts.injection < 4 || unique.size !== 48) throw new Error('Invalid fixture coverage');

  const rank = index(gold.passages);
  const misses: string[] = [];
  let hitFraction = 0;
  for (const question of gold.questions.filter((row) => row.class === 'answerable')) {
    const hits = rank(question.query);
    const fraction = question.evidence.filter((id) => hits.includes(id)).length / question.evidence.length;
    hitFraction += fraction;
    if (fraction !== 1) misses.push(question.id);
  }
  for (const { query } of gold.questions) rank(query);
  const times: number[] = [];
  for (let pass = 0; pass < repetitions; pass++) for (const { query } of gold.questions) {
    const before = performance.now();
    rank(query);
    times.push(performance.now() - before);
  }
  times.sort((a, b) => a - b);
  const percentile = (value: number) => Number(times[Math.ceil(times.length * value) - 1].toFixed(4));
  return { version: gold.version, sha256: createHash('sha256').update(bytes).digest('hex'), counts,
    passages: passages.size, recallAt5: hitFraction / counts.answerable, misses,
    latencyMs: { samples: times.length, p50: percentile(0.5), p95: percentile(0.95) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(evaluate(readFileSync(fixture))));
}
