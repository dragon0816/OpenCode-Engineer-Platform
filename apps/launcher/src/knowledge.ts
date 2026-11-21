import { appendFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { knowledgeCompletion, knowledgeModel } from '../../adapter/src/opencode/knowledge-model.ts';
import { startKnowledgeMcp } from '../../adapter/src/opencode/knowledge-mcp.ts';
import { startGateway } from '../../adapter/src/opencode/gateway.ts';
import { KnowledgeAsk } from '../../../packages/knowledge/src/ask.ts';
import { inspectRepository, readRepository } from '../../../packages/knowledge/src/repository.ts';
import { KnowledgeStore } from '../../../packages/knowledge/src/store.ts';
import { checkDirectory } from '../../adapter/src/runs/workspace.ts';

export const knowledgeFile = 'knowledge.sqlite';

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
  options: Pick<Parameters<typeof startGateway>[0], 'url' | 'key' | 'alias' | 'fetch'>) {
  const databaseRoot = dirname(profile);
  const path = join(databaseRoot, knowledgeFile);
  verifyKnowledgePath(path);
  const store = new KnowledgeStore(path);
  let reader: KnowledgeStore | undefined;
  let relay: Awaited<ReturnType<typeof startGateway>> | undefined;
  let mcp: Awaited<ReturnType<typeof startKnowledgeMcp>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([mcp?.close(), relay?.close()]);
    reader?.close();
    store.close();
    if (results.some((result) => result.status === 'rejected')) throw new Error('Knowledge services could not close');
  };
  try {
    relay = await startGateway({ ...options, web: true,
      trace: (row) => appendFileSync(join(audit, 'knowledge-gateway.jsonl'), JSON.stringify(row) + '\n') });
    const queryStore = reader = new KnowledgeStore(path, true);
    const ask = new KnowledgeAsk(queryStore, knowledgeModel(relay, options.alias));
    mcp = await startKnowledgeMcp(ask);
    return { ask, reviewStore: store, overview: () => queryStore.overview(), inspectRepository,
      importRepository: (folder: string, allowModel: boolean) => importKnowledgeRepository(path, folder, allowModel),
      propose: (prompt: string, input: unknown, signal: AbortSignal) =>
        knowledgeCompletion(relay!, options.alias, prompt, input, signal),
      config: mcp.config, close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Knowledge startup and cleanup failed'); }
    throw error;
  }
}
