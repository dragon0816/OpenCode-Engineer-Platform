import { appendFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { knowledgeCompletion, knowledgeModel } from '../../adapter/src/opencode/knowledge-model.ts';
import { startGateway } from '../../adapter/src/opencode/gateway.ts';
import { ocrVision } from '../../adapter/src/opencode/ocr-vision.ts';
import { KnowledgeAsk } from '../../../packages/knowledge/src/ask.ts';
import type { AskRequest } from '../../../packages/knowledge/src/ask.ts';
import { inspectRepository, readRepository } from '../../../packages/knowledge/src/repository.ts';
import { KnowledgeStore } from '../../../packages/knowledge/src/store.ts';
import { checkDirectory } from '../../adapter/src/runs/workspace.ts';
import { ModelSeat } from '../../adapter/src/opencode/model-seat.ts';

export const knowledgeFile = 'knowledge.sqlite';
type AskScope = { model: string; vaults: readonly string[] };

export function verifyKnowledgePath(path: string) {
  checkDirectory(dirname(path));
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    let stat;
    try { stat = lstatSync(path + suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Knowledge database path is unsafe');
  }
}

function prepareKnowledgeDirectory(path: string) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!stat) {
    const parent = dirname(path);
    if (parent === path) throw new Error('Knowledge database path is unsafe');
    prepareKnowledgeDirectory(parent);
    mkdirSync(path, { recursive: true });
  }
  checkDirectory(path);
}

export function importKnowledgeRepository(path: string, folder: string, allowModel = false) {
  const { snapshot, original, digestVerified, sizeVerified } = readRepository(folder, path);
  prepareKnowledgeDirectory(dirname(path));
  verifyKnowledgePath(path);
  const store = new KnowledgeStore(path);
  try {
    const report = store.import(snapshot, original, allowModel);
    const active = store.isCurrent(report.vault, report.revision, report.snapshot);
    return { state: report.state, vault: report.vault, tag: snapshot.repository!.tag, revision: report.revision,
      schemaVersion: snapshot.schema.version, active, digestVerified, sizeVerified, cards: report.cards.length,
      sources: report.sources.length, relationships: report.relationships.length, passages: report.passages.length };
  } finally { store.close(); }
}

export async function startKnowledgeRuntime(profile: string, audit: string,
  options: Pick<Parameters<typeof startGateway>[0], 'url' | 'key' | 'alias' | 'fetch'> & { aliases: readonly string[] },
  defaultAlias: () => string, modelSeat: ModelSeat) {
  const databaseRoot = dirname(profile);
  const path = join(databaseRoot, knowledgeFile);
  verifyKnowledgePath(path);
  const store = new KnowledgeStore(path);
  let reader: KnowledgeStore | undefined;
  let relay: Awaited<ReturnType<typeof startGateway>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([relay?.close()]);
    reader?.close();
    store.close();
    if (results.some((result) => result.status === 'rejected')) throw new Error('Knowledge services could not close');
  };
  try {
    relay = await startGateway({ ...options, web: true,
      trace: (row) => appendFileSync(join(audit, 'knowledge-gateway.jsonl'), JSON.stringify(row) + '\n') });
    const queryStore = reader = new KnowledgeStore(path, true);
    const models = new Map(options.aliases.map((alias) => [alias, knowledgeModel(relay!, alias)]));
    const benchmarks = new Map([...models].map(([alias, model]) => [alias,
      new KnowledgeAsk(queryStore, (question, evidence, signal) => modelSeat.run(() => model(question, evidence, signal), signal))]));
    const ask = () => benchmarks.get(defaultAlias())!;
    // MCP asks already hold the OpenCode turn's model seat.
    const nested = new ModelSeat();
    const scoped = new Map([...models].map(([alias, model]) => [alias, new KnowledgeAsk(queryStore, model)]));
    const scopedAsk = async (input: AskRequest, signal: AbortSignal, resolve: () => AskScope | undefined, inTurn = false,
      beforeRequest?: () => void) => {
      const model = resolve()?.model;
      const service = model && scoped.get(model);
      const authorized = () => {
        const scope = resolve();
        return Boolean(scope && scope.model === model && scope.vaults.includes(input.vault));
      };
      if (!service || !authorized()) return { state: 'abstain', reason: 'vault-unavailable' } as const;
      const limited = beforeRequest && model ? new KnowledgeAsk(queryStore, knowledgeModel(relay!, model, beforeRequest)) : service;
      return (inTurn ? nested : modelSeat).run(() => limited.ask(input, signal, undefined, authorized), signal);
    };
    return { get ask() { return ask(); }, scopedAsk, benchmarks, reviewStore: store, overview: () => queryStore.overview(), inspectRepository,
      ocrVision: ocrVision(relay, modelSeat, options.aliases, defaultAlias),
      importRepository: (folder: string, allowModel: boolean) => importKnowledgeRepository(path, folder, allowModel),
      readRepository: (folder: string) => readRepository(folder, path),
      propose: (prompt: string, input: unknown, signal: AbortSignal, model = defaultAlias(), beforeRequest?: () => void, maxTokens?: number) =>
        modelSeat.run(() => knowledgeCompletion(relay!, models.has(model) ? model : defaultAlias(), prompt, input, signal, beforeRequest, maxTokens), signal),
      close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Knowledge startup and cleanup failed'); }
    throw error;
  }
}
