import { appendFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { knowledgeModel } from '../../adapter/src/opencode/knowledge-model.ts';
import { startKnowledgeMcp } from '../../adapter/src/opencode/knowledge-mcp.ts';
import { startGateway } from '../../adapter/src/opencode/gateway.ts';
import { KnowledgeAsk } from '../../../packages/knowledge/src/ask.ts';
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

export async function startKnowledgeRuntime(profile: string, audit: string,
  options: Pick<Parameters<typeof startGateway>[0], 'url' | 'key' | 'alias' | 'fetch'>) {
  const databaseRoot = dirname(profile);
  const path = join(databaseRoot, knowledgeFile);
  verifyKnowledgePath(path);
  new KnowledgeStore(path).close();
  const store = new KnowledgeStore(path, true);
  let relay: Awaited<ReturnType<typeof startGateway>> | undefined;
  let mcp: Awaited<ReturnType<typeof startKnowledgeMcp>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([mcp?.close(), relay?.close()]);
    store.close();
    if (results.some((result) => result.status === 'rejected')) throw new Error('Knowledge services could not close');
  };
  try {
    relay = await startGateway({ ...options, web: true,
      trace: (row) => appendFileSync(join(audit, 'knowledge-gateway.jsonl'), JSON.stringify(row) + '\n') });
    const ask = new KnowledgeAsk(store, knowledgeModel(relay, options.alias));
    mcp = await startKnowledgeMcp(ask);
    return { ask, overview: () => store.overview(), config: mcp.config, close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Knowledge startup and cleanup failed'); }
    throw error;
  }
}
