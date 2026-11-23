// Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/host/bi_bench.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
import { verifyKnowledgeAnswer, type ModelResult } from '../../../../packages/knowledge/src/ask.ts';
import { normalizedPassage, searchTerms } from '../../../../packages/knowledge/src/retrieval.ts';
import { sha256, type Snapshot } from '../../../../packages/knowledge/src/snapshot.ts';
import { knowledgeInstructions } from '../opencode/knowledge-model.ts';
import type { PipelineSettings } from './pipeline-settings.ts';

type TestSettings = PipelineSettings['testing'];
type Completion = (prompt: string, input: unknown, signal: AbortSignal, alias?: string) => Promise<ModelResult>;
type Outcome = { question: string; passed: boolean; state: 'verified' | 'abstain' | 'unavailable' | 'invalid';
  citations?: { source: string; locator: string; quote: string }[] };
export type BenchmarkReport = { name: string; state: 'passed' | 'failed' | 'skipped'; threshold: number;
  passed: number; total: number; evidence?: boolean; results: Outcome[] };

export async function runBenchmark(snapshot: Snapshot, settings: TestSettings, complete: Completion | undefined,
  signal: AbortSignal): Promise<BenchmarkReport> {
  const sources = new Map(snapshot.sources.map(({ id, ref }) => [id, ref]));
  const passages = snapshot.passages.map(({ sourceId, ...passage }) => ({ ...passage, source: sources.get(sourceId) ?? '' }));
  const evidence = settings.evidenceChecks ? passages.length > 0 && passages.every(passage =>
    Boolean(passage.source && passage.locator && passage.text.trim()) && sha256(passage.text) === passage.sha256) : undefined;
  const results: Outcome[] = [];
  for (const { question, expect } of settings.questions) {
    signal.throwIfAborted();
    const { words, parts, specs } = searchTerms(question);
    const terms = new Set([...words, ...parts, ...specs]);
    const selected = passages.map(passage => {
      const tokens = searchTerms(passage.text);
      return { passage, score: [...tokens.words, ...tokens.parts, ...tokens.specs].filter(token => terms.has(token)).length };
    }).filter(({ score }) => score).sort((a, b) => b.score - a.score).slice(0, 12).map(({ passage }) => passage);
    if (!complete) {
      results.push({ question, state: 'unavailable', passed: false });
      continue;
    }
    if (!selected.length) {
      results.push({ question, state: 'abstain', passed: expect === null });
      continue;
    }
    const response = await complete(knowledgeInstructions,
      { question, evidence: selected.map(({ id, text }) => ({ id, text })) }, signal, settings.model || undefined);
    signal.throwIfAborted();
    const answer = 'content' in response ? verifyKnowledgeAnswer({ question, revision: snapshot.publication.revision,
      passages: selected }, response.content) : undefined;
    const state = answer?.state ?? ('failure' in response ? 'unavailable' : 'invalid');
    const citations = answer?.state === 'verified' ? answer.citations.map(({ source, locator, quote }) => ({ source, locator, quote })) : undefined;
    const contains = (text: string, wanted: string) => normalizedPassage(text).toLowerCase().includes(normalizedPassage(wanted).toLowerCase());
    results.push({ question, state, citations, passed: expect === null ? state === 'abstain' : Boolean(citations?.some(({ quote }) => contains(quote, expect))) });
  }
  const passed = results.filter(result => result.passed).length;
  const total = results.length;
  const state = evidence === false || total && passed * 100 < total * settings.threshold ? 'failed' : total ? 'passed' : 'skipped';
  return { name: settings.name, state, threshold: settings.threshold, passed, total, evidence, results };
}
