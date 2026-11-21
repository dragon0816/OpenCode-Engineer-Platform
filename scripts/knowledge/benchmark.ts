import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeAsk } from '../../packages/knowledge/src/ask.ts';
import type { Attempt } from '../../packages/knowledge/src/ask.ts';
import { readRepository } from '../../packages/knowledge/src/repository.ts';
import { canonical, sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { gatewayAliases, gatewaySettings, startGateway } from '../../apps/adapter/src/opencode/gateway.ts';
import type { GatewayTrace } from '../../apps/adapter/src/opencode/gateway.ts';
import { knowledgeModel } from '../../apps/adapter/src/opencode/knowledge-model.ts';
import { goldFixture } from '../../tests/fixtures/knowledge/gold.ts';
import { syntheticRepository } from '../../tests/fixtures/knowledge/repository.ts';
import { evaluate } from '../phase0/knowledge-baseline.ts';

const { snapshot, questions: goldQuestions, baseline, extension, extendedBaseline } = goldFixture();
const args = process.argv.slice(2);
const repository = args.includes('--repository');
const selected = args.filter((argument) => argument !== '--repository');
if (selected.some((alias) => !gatewayAliases.some((approved) => approved === alias))) throw new Error('Invalid benchmark alias');
mkdirSync('.phase0', { recursive: true });
const audit = mkdtempSync(join('.phase0', 'knowledge-gold-'));
const write = (file: string, value: object) => appendFileSync(join(audit, file), JSON.stringify(value) + '\n');
const mirror = join(audit, 'repository');
const fixture = repository ? syntheticRepository(mirror, { snapshot }) : undefined;
const input = fixture ? readRepository(mirror) : { snapshot, original: Buffer.from(canonical(snapshot)) };
const questions = fixture ? goldQuestions.map((question) => ({ ...question,
  evidence: question.evidence.map((id) => {
    const mapped = fixture.evidenceIds.get(id);
    if (!mapped) throw new Error('Missing benchmark evidence in synthetic repository');
    return mapped;
  }),
})) : goldQuestions;
console.log(JSON.stringify({ audit, aliases: selected.length ? selected : gatewayAliases, fixture: sha256(input.original),
  ...(input.snapshot.repository && { tag: input.snapshot.repository.tag, revision: input.snapshot.publication.revision }),
  baseline: sha256(baseline), extension: sha256(extension) }));

const store = new KnowledgeStore(':memory:');
try {
  const vault = input.snapshot.vault.id;
  store.import(input.snapshot, input.original, true);
  const retrievable = questions.filter((question) => question.class === 'answerable');
  const coverage = retrievable.map(({ id, query, evidence }) => {
    const hits = store.retrieve(vault, query)?.passages.map((passage) => passage.id) ?? [];
    return { id, hits, recall: evidence.filter((passage) => hits.includes(passage)).length / evidence.length };
  });
  const recallAt5 = coverage.reduce((total, row) => total + row.recall, 0) / coverage.length;
  const baselineRecall = evaluate(extendedBaseline, 1).recallAt5;
  write('retrieval.jsonl', { recallAt5, baselineRecall, coverage });
  console.log(JSON.stringify({ recallAt5, baselineRecall, misses: coverage.filter((row) => row.recall < 1).map((row) => row.id) }));
  const settings = gatewaySettings();
  async function run(alias: string) {
    const requests: GatewayTrace[] = [];
    const relay = await startGateway({ ...settings, alias, web: true, trace: (value) => requests.push(value) });
    try {
      const ask = new KnowledgeAsk(store, knowledgeModel(relay, alias));
      const totals = { questions: 0, modelAttempts: 0, usable: 0, answerable: 0, abstained: 0, unanswerable: 0,
        errors: 0, criticalUnsupported: 0, citations: 0, reproducible: 0 };
      const misses: string[] = [];
      for (const item of questions) {
        const cursor = requests.length;
        const attempts: Attempt[] = [];
        const started = performance.now();
        const scope = { vault, question: item.query };
        const result = await ask.ask(scope, AbortSignal.timeout(76_000), (attempt) => attempts.push(attempt));
        totals.questions++;
        totals.modelAttempts += attempts.length;
        const answerable = item.class === 'answerable';
        if (answerable) totals.answerable++;
        else totals.unanswerable++;
        if (result.state === 'error') totals.errors++;
        let usable = false;
        let reproducible = 0;
        let unsupported = 0;
        if (result.state === 'verified') {
          const stored = store.snapshot(vault, result.revision)!;
          const hits = result.citations.map((citation) => citation.passageID);
          usable = Boolean(answerable && item.answer && result.answer.toLowerCase().includes(item.answer.toLowerCase()) &&
            item.evidence.every((id) => hits.includes(id)) && hits.every((id) => item.evidence.includes(id)));
          if (!answerable || hits.some((id) => !item.evidence.includes(id))) unsupported++;
          for (const citation of result.citations) {
            const source = stored.sources.find((candidate) => candidate.id === citation.sourceId);
            const passage = stored.passages.find((candidate) => candidate.id === citation.passageID);
            if (passage && source && passage.sourceId === source.id && passage.locator === citation.locator &&
                sha256(passage.text) === citation.sha256 && passage.text === citation.context && passage.text.includes(citation.quote) &&
                source.ref === citation.source && source.version === citation.sourceVersion) reproducible++;
          }
          totals.citations += result.citations.length;
        }
        if (usable) totals.usable++;
        if (result.state === 'abstain' && !answerable) totals.abstained++;
        if (answerable ? !usable : result.state !== 'abstain') misses.push(item.id);
        totals.reproducible += reproducible;
        totals.criticalUnsupported += unsupported;
        write(`${alias}.jsonl`, { id: item.id, class: item.class, attempts, requests: requests.slice(cursor), result, usable,
          reproducible, unsupported, elapsedMs: Math.round(performance.now() - started) });
      }
      const result = { alias, ...totals, misses };
      write('summary.jsonl', result);
      console.log(JSON.stringify(result));
    } finally { await relay.close(); }
  }
  await Promise.all((selected.length ? [...new Set(selected)] : gatewayAliases).map(run));
} finally { store.close(); }
