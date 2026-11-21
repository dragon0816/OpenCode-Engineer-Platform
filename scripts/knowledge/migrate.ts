import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { importKnowledgeRepository, knowledgeFile, verifyKnowledgePath } from '../../apps/launcher/src/knowledge.ts';
import { publishedInput } from '../../packages/knowledge/src/convert-aep.ts';
import { repositoryErrorReport } from '../../packages/knowledge/src/repository.ts';
import { RepositoryError } from '../../packages/knowledge/src/repository-files.ts';
import { canonical, sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';

function dataPath(create = true) {
  const data = process.env.OEP_DATA_DIR || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'OEP'));
  if (!data || !isAbsolute(data)) throw new Error('OEP data directory must be absolute');
  const folder = join(data, 'web');
  if (create) mkdirSync(folder, { recursive: true });
  return join(folder, knowledgeFile);
}

function run() {
  const [action, input, ...flags] = process.argv.slice(2);
  if (action === '--import-repo') {
    if (!input || input.startsWith('--') || flags.length > 1 || flags.some((flag) => flag !== '--allow-model')) {
      throw new Error('Use --import-repo FOLDER [--allow-model]');
    }
    console.log(JSON.stringify(importKnowledgeRepository(dataPath(false), input, flags.length === 1)));
    return;
  }
  if (action === '--restore-repo') {
    if (!input || flags.length !== 1 || flags[0].startsWith('--')) throw new Error('Use --restore-repo VAULT REVISION');
    const path = dataPath(false);
    verifyKnowledgePath(path);
    const store = new KnowledgeStore(path);
    try {
      store.restoreRepositoryGeneration(input, flags[0]);
      console.log(JSON.stringify({ state: 'restored', vault: input, revision: flags[0] }));
    } finally { store.close(); }
    return;
  }
  if (action === '--dry-run' || action === '--import') {
    if (!input || input.startsWith('--')) throw new Error('Provide a local published snapshot file');
    let allowModel = false;
    let wikiRoot: string | undefined;
    for (let index = 0; index < flags.length; index++) {
      const flag = flags[index];
      if (flag === '--allow-model' && !allowModel) allowModel = true;
      else if (flag === '--wiki-root' && !wikiRoot && flags[index + 1] && !flags[index + 1].startsWith('--')) wikiRoot = flags[++index];
      else throw new Error('Invalid migration options');
    }
    const { snapshot, original } = publishedInput(input, wikiRoot);
    const shadow = new KnowledgeStore(':memory:');
    let report;
    try {
      report = shadow.import(snapshot, original, allowModel);
      shadow.rebuild();
      if (canonical(shadow.snapshot(snapshot.vault.id, snapshot.publication.revision)) !== canonical(snapshot)) {
        throw new Error('Shadow import does not match the snapshot');
      }
    } finally { shadow.close(); }
    if (sha256(publishedInput(input, wikiRoot).original) !== report.input) throw new Error('Input changed during migration');
    if (action === '--dry-run') {
      console.log(JSON.stringify({ ...report, state: 'dry-run', sourceUnchanged: true, shadowVerified: true }));
      return;
    }
    const path = dataPath();
    verifyKnowledgePath(path);
    const store = new KnowledgeStore(path);
    try {
      console.log(JSON.stringify({ ...store.import(snapshot, original, allowModel), sourceUnchanged: true, shadowVerified: true }));
    } finally { store.close(); }
    return;
  }
  if ((action !== '--rebuild' && action !== '--backup') || input !== undefined) {
    throw new Error('Use --dry-run FILE, --import FILE, --import-repo FOLDER, --restore-repo VAULT REVISION, --rebuild, or --backup');
  }
  const path = dataPath();
  verifyKnowledgePath(path);
  const store = new KnowledgeStore(path);
  try {
    if (action === '--rebuild') console.log(JSON.stringify({ rebuilt: store.rebuild() }));
    else {
      const backup = join(dirname(path), `knowledge-backup-${randomUUID()}.sqlite`);
      store.backup(backup);
      console.log(JSON.stringify({ backup }));
    }
  } finally { store.close(); }
}

try { run(); }
catch (error) {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(Invalid |Provide |Use |AEP BI checksum|OEP data|Knowledge database path|Published revision|Published vault|Shadow import|Input changed|Repository generation|Repository publication)/;
  console.error(error instanceof RepositoryError ? JSON.stringify(repositoryErrorReport(error, true)) :
    safe.test(message) ? message : 'Could not read, verify, or store the published snapshot.');
  process.exitCode = 1;
}
