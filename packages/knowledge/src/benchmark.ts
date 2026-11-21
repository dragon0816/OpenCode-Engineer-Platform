import { identifier } from './snapshot.ts';

export type BenchmarkQuestion = {
  id: string;
  query: string;
  class: 'answerable' | 'no-evidence' | 'conflict' | 'injection';
  answer: string | null;
  evidence: string[];
};

export function benchmarkQuestions(value: unknown): BenchmarkQuestion[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return;
  const ids = new Set<string>();
  const questions: BenchmarkQuestion[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') return;
    const { id, query, class: kind, answer, evidence } = row;
    if (typeof id !== 'string' || !identifier.test(id) || ids.has(id) ||
        typeof query !== 'string' || !query.trim() || !query.isWellFormed() || query.length > 500 ||
        !['answerable', 'no-evidence', 'conflict', 'injection'].includes(kind) ||
        (answer !== null && (typeof answer !== 'string' || answer.length > 2000)) ||
        !Array.isArray(evidence) || evidence.length > 10 ||
        evidence.some((item) => typeof item !== 'string' || !identifier.test(item)) ||
        (kind === 'answerable' && (!answer?.trim() || !evidence.length))) return;
    ids.add(id);
    questions.push({ id, query: query.trim(), class: kind, answer, evidence: [...new Set<string>(evidence)] });
  }
  return questions;
}
