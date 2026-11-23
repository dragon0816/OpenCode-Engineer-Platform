import type { IncomingMessage } from 'node:http';
import { basename } from 'node:path';
import { maxSnapshotBytes, publishedBytes } from '../../../../packages/knowledge/src/convert-aep.ts';
import { isLocalAbsoluteFolder } from '../../../../packages/knowledge/src/repository-files.ts';
import { identifier } from '../../../../packages/knowledge/src/snapshot.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { readSkillFolder, readSkillZip, skillZipLimit } from '../runs/capability-library.ts';
import type { ReferencePicker } from '../runs/reference-picker.ts';
import type { WebStore } from '../runs/web-store.ts';
import { header } from './auth.ts';
import { HttpError } from './errors.ts';
import type { WebMessageCode } from './messages.ts';

async function upload(request: IncomingMessage, limit: number, code: WebMessageCode) {
  if (header(request, 'content-type') !== 'application/octet-stream' || header(request, 'content-encoding')) throw new HttpError(415, code);
  const length = Number(header(request, 'content-length'));
  if (!Number.isSafeInteger(length) || length < 1 || length > limit) throw new HttpError(413, code);
  const bytes = Buffer.alloc(length);
  let offset = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    if (offset + chunk.length > length) throw new HttpError(413, code);
    offset += chunk.copy(bytes, offset);
  }
  if (offset !== length) throw new HttpError(400, code);
  return bytes;
}

function sourceName(request: IncomingMessage, code: WebMessageCode) {
  try {
    const name = decodeURIComponent(header(request, 'x-oep-filename'));
    if (name && name.length <= 255 && !/[\\/:\p{Cc}]/u.test(name)) return name;
  } catch { /* Report a fixed input error. */ }
  throw new HttpError(400, code);
}

export function capabilityManagement(store: WebStore, knowledge: Runtime['knowledge'], picker: ReferencePicker) {
  const library = store.capabilityLibrary();
  const skills = () => library.list(store.agents().filter(({ state }) => state === 'active').map(({ id, name }) => ({ id, name })));
  let picking = false;
  async function folderInput(input: Record<string, unknown>, signal: AbortSignal) {
    let { folder } = input;
    if (input.pick === true) {
      if (folder !== undefined || input.locale !== 'en' && input.locale !== 'zh-TW') throw new HttpError(400, 'invalid-repository-path');
      if (picking) throw new HttpError(409, 'reference-picker-busy');
      picking = true;
      try { [folder] = await picker('folder', input.locale, signal); }
      finally { picking = false; }
      if (folder === undefined) return;
    }
    if (typeof folder !== 'string' || folder.length > 2048 || !isLocalAbsoluteFolder(folder)) throw new HttpError(400, 'invalid-repository-path');
    return folder;
  }

  return async (path: string, request: IncomingMessage, body: () => Promise<Record<string, unknown>>, signal: AbortSignal) => {
    const [, , , section, action, ...rest] = path.split('/');
    const get = request.method === 'GET';
    const missing = () => new HttpError(404, 'route-not-found');
    if (rest.length || get === Boolean(action)) throw missing();
    if (section === 'skills') {
      if (get) return skills();
      if (action === 'zip') {
        const filename = sourceName(request, 'skill-package-invalid');
        const bytes = await upload(request, skillZipLimit, 'skill-package-invalid');
        library.install(readSkillZip(bytes), filename);
      } else if (action === 'folder') {
        const folder = await folderInput(await body(), signal);
        if (folder === undefined) return null;
        library.install(readSkillFolder(folder), basename(folder));
      } else if (action === 'enable' || action === 'remove') {
        const { name, assistant, enabled } = await body();
        if (typeof name !== 'string' || name.length > 64) throw new HttpError(400, 'skill-frontmatter-invalid');
        if (action === 'remove') library.remove(name);
        else {
          if (typeof assistant !== 'string' || assistant.length > 80 || typeof enabled !== 'boolean') throw new HttpError(400, 'skill-or-assistant-missing');
          library.enable(assistant, name, enabled);
        }
        store.capabilitiesChanged();
      } else throw missing();
      return skills();
    }
    if (section === 'workflows') {
      if (action === 'import') library.importWorkflow(await upload(request, 1024 * 1024, 'workflow-package-invalid'));
      else if (!get) throw missing();
      return library.workflows();
    }
    if (section !== 'knowledge') throw missing();
    if (!knowledge) throw new HttpError(503, 'knowledge-import-unavailable');
    if (get) return knowledge.reviewStore.publishedImports();
    if (action === 'remove') {
      const { id, revision } = await body();
      if (typeof id !== 'string' || !identifier.test(id) || typeof revision !== 'string' || !identifier.test(revision) ||
        !knowledge.reviewStore.removePublishedImport(id, revision)) throw new HttpError(409, 'knowledge-import-changed');
      store.removeKnowledgeRead(id);
    } else if (action === 'repository') {
      const input = await body();
      if (input.allowModel !== undefined && typeof input.allowModel !== 'boolean') throw new HttpError(400, 'invalid-repository-path');
      const folder = await folderInput(input, signal);
      if (folder === undefined) return null;
      try { knowledge.importRepository(folder, input.allowModel === true, basename(folder)); }
      catch { throw new HttpError(422, 'repository-import-failed'); }
    } else if (action === 'package' || action === 'package-model') {
      const source = sourceName(request, 'knowledge-package-invalid');
      const bytes = await upload(request, maxSnapshotBytes, 'knowledge-package-invalid');
      try {
        const { snapshot, original } = publishedBytes(bytes);
        knowledge.reviewStore.import(snapshot, original, action === 'package-model', source);
      } catch { throw new HttpError(422, 'knowledge-package-invalid'); }
    } else throw missing();
    return knowledge.reviewStore.publishedImports();
  };
}
