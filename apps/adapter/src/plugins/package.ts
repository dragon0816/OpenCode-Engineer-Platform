import { createHash } from 'node:crypto';
import semver from 'semver';
import { fileLimit, manifestLimit, payloadPath, readArchive, requirePlugin } from './zip.ts';

export const pluginID = /^[a-z][a-z\d-]{0,29}(?:\.[a-z][a-z\d-]{0,29}){1,3}$/;
export const digestPattern = /^[a-f\d]{64}$/;
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const compatibleWith = (oepVersion: string, range: string) => semver.satisfies(oepVersion, range);

export function strictJSON(bytes: Uint8Array): unknown {
  let source: string;
  let parsed: unknown;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch { requirePlugin(false); }
  const levels: (Set<string> | null)[] = [];
  // JSON.parse checks grammar first. Quoted tokens include their escaped delimiters.
  for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}\[\]]/g)) {
    const value = token[0];
    if (value === '{') levels.push(new Set());
    else if (value === '[') levels.push(null);
    else if (value === '}' || value === ']') levels.pop();
    else if (value.endsWith(':')) {
      const key = JSON.parse(value.slice(0, -1)) as string;
      const fields = levels.at(-1);
      requirePlugin(fields && !fields.has(key));
      fields.add(key);
    }
  }
  return parsed;
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  requirePlugin(value && typeof value === 'object' && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  requirePlugin(required.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => required.includes(key) || optional.includes(key)));
  return record;
}

function string(value: unknown, limit = 160) {
  requirePlugin(typeof value === 'string' && value.trim() && value.length <= limit && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));
  return value;
}

function array<T>(value: unknown, parse: (item: unknown) => T, limit = 32) {
  requirePlugin(Array.isArray(value) && value.length <= limit);
  return value.map(parse);
}

function unique(values: readonly string[]) { requirePlugin(new Set(values).size === values.length); }

export function version(value: unknown) {
  const text = string(value, 64);
  requirePlugin(/^\d+\.\d+\.\d+(?:-[a-z\d.-]+)?(?:\+[a-z\d.-]+)?$/i.test(text) && semver.valid(text));
  return text;
}

const keyPattern = /^[a-z][a-z\d]*(?:[.-][a-z\d]+)*$/;
const messageKey = (value: unknown) => {
  const text = string(value, 80);
  requirePlugin(keyPattern.test(text));
  return text;
};

const locales = ['zh-TW', 'en'] as const;
type Locale = typeof locales[number];
type Localized = Record<Locale, string>;
const operations = ['data.read', 'data.write', 'worker.run', 'review.submit', 'publish.request', 'progress.emit'] as const;
type Operation = typeof operations[number];

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  requirePlugin(choices.includes(value as T));
  return value as T;
}

export function parseManifest(raw: Buffer) {
  requirePlugin(raw.length <= manifestLimit);
  const manifest = object(strictJSON(raw), ['format', 'id', 'version', 'publisher', 'oepCompatibility',
    'permissions', 'components', 'files'], ['name']);
  requirePlugin(manifest.format === 'oep.plugin/v1');
  const id = string(manifest.id);
  requirePlugin(pluginID.test(id));
  const label = manifest.name === undefined ? undefined : object(manifest.name, locales);
  const name: Localized = label ? { 'zh-TW': string(label['zh-TW']), en: string(label.en) } : { 'zh-TW': id, en: id };
  const publisher = string(manifest.publisher);
  const oepCompatibility = string(manifest.oepCompatibility, 256);
  requirePlugin(semver.validRange(oepCompatibility) !== null);
  const files = array(manifest.files, (item) => {
    const row = object(item, ['path', 'size', 'sha256']);
    const path = string(row.path, 200);
    const digest = string(row.sha256, 64);
    requirePlugin(payloadPath(path) && typeof row.size === 'number' && Number.isSafeInteger(row.size) &&
      row.size >= 0 && row.size <= fileLimit && digestPattern.test(digest));
    return { path, size: row.size, sha256: digest };
  }, 256);
  unique(files.map((file) => file.path.toLowerCase()));
  const fileNames = new Set(files.map((file) => file.path));
  const file = (value: unknown, extension: string) => {
    const path = string(value, 200);
    requirePlugin(path.endsWith(extension) && fileNames.has(path));
    return path;
  };
  const componentID = (value: unknown) => {
    const name = string(value);
    requirePlugin(name.startsWith(id + '.') && keyPattern.test(name));
    return name;
  };
  const requested = object(manifest.permissions, ['operations', 'dataScope', 'workers', 'modelBroker', 'sourceBroker']);
  const permissions = {
    operations: array(requested.operations, (operation): Operation => choice(operation, operations)),
    dataScope: choice(requested.dataScope, ['none', 'plugin-workspace']),
    workers: array(requested.workers, componentID),
    modelBroker: choice(requested.modelBroker, ['none', 'approved-gateway']),
    sourceBroker: choice(requested.sourceBroker, ['none', 'approved-sources']),
  };
  unique(permissions.operations);
  unique(permissions.workers);
  requirePlugin(!permissions.operations.some((op) => op.startsWith('data.')) || permissions.dataScope === 'plugin-workspace');

  const definitions = object(manifest.components, ['skills', 'workflows', 'pythonWorkers', 'dataSchemas',
    'pages', 'panels', 'reviewTypes', 'collections']);
  const entry = (extension: string) => (value: unknown) => {
    const component = object(value, ['id', 'version', 'entry']);
    return { id: componentID(component.id), version: version(component.version), entry: file(component.entry, extension) };
  };
  const view = (value: unknown) => {
    const component = object(value, ['id', 'version', 'entry', 'titleKey', 'strings']);
    const strings = object(component.strings, locales);
    return { id: componentID(component.id), version: version(component.version), entry: file(component.entry, '.json'),
      titleKey: messageKey(component.titleKey), strings: { 'zh-TW': file(strings['zh-TW'], '.json'), en: file(strings.en, '.json') } };
  };
  const components = {
    skills: array(definitions.skills, entry('.json')),
    workflows: array(definitions.workflows, entry('.json')),
    pythonWorkers: array(definitions.pythonWorkers, entry('.py')),
    dataSchemas: array(definitions.dataSchemas, entry('.json')),
    pages: array(definitions.pages, view),
    panels: array(definitions.panels, view),
    reviewTypes: array(definitions.reviewTypes, (value) => {
      const item = object(value, ['id', 'version', 'schema']);
      return { id: componentID(item.id), version: version(item.version), schema: componentID(item.schema) };
    }),
    collections: array(definitions.collections, (value) => {
      const item = object(value, ['id', 'version', 'schema', 'uniqueKey', 'readScope', 'writeScope', 'requiresReview']);
      requirePlugin(typeof item.requiresReview === 'boolean');
      return { id: componentID(item.id), version: version(item.version), schema: componentID(item.schema),
        uniqueKey: messageKey(item.uniqueKey), readScope: choice(item.readScope, ['plugin-workspace']),
        writeScope: choice(item.writeScope, ['plugin-workspace']), requiresReview: item.requiresReview };
    }),
  };
  unique(Object.values(components).flat().map((item) => item.id));
  requirePlugin(permissions.workers.every((worker) => components.pythonWorkers.some(({ id }) => id === worker)) &&
    (permissions.operations.includes('worker.run') === (permissions.workers.length > 0)) &&
    components.pythonWorkers.every(({ id }) => permissions.workers.includes(id)) &&
    (components.collections.length === 0 || permissions.operations.includes('data.read') && permissions.operations.includes('data.write')) &&
    (components.reviewTypes.length === 0 || permissions.operations.includes('review.submit')) &&
    [...components.reviewTypes, ...components.collections].every(({ schema }) => components.dataSchemas.some(({ id }) => id === schema)));
  return { id, version: version(manifest.version), name, publisher, oepCompatibility, permissions, components, files };
}

export type PluginManifest = ReturnType<typeof parseManifest>;
type View = { id: string; title: Localized; paragraphs: Localized[] };

function readViews(manifest: PluginManifest, payload: ReadonlyMap<string, Buffer>) {
  const views: View[] = [];
  const json = (path: string) => {
    const bytes = payload.get('payload/' + path);
    requirePlugin(bytes && bytes.length <= manifestLimit);
    return strictJSON(bytes);
  };
  for (const component of [...manifest.components.pages, ...manifest.components.panels]) {
    const page = object(json(component.entry), ['format', 'paragraphs']);
    requirePlugin(page.format === 'oep.plugin.page/v1');
    const keys = array(page.paragraphs, messageKey, 16);
    const catalogs = locales.map((language) => object(json(component.strings[language]), [component.titleKey, ...keys]));
    const label = (key: string): Localized => ({ 'zh-TW': string(catalogs[0][key], 2000), en: string(catalogs[1][key], 2000) });
    views.push({ id: component.id, title: label(component.titleKey), paragraphs: keys.map(label) });
  }
  for (const component of [...manifest.components.dataSchemas, ...manifest.components.skills, ...manifest.components.workflows]) {
    const value = json(component.entry);
    requirePlugin(value && typeof value === 'object' && !Array.isArray(value));
  }
  return views;
}

export function verifyPackage(bytes: Buffer) {
  const entries = readArchive(bytes);
  const raw = entries.get('manifest.json');
  requirePlugin(raw);
  const manifest = parseManifest(raw);
  // manifest.sig is a reserved optional ZIP member with no effect on v1 admission.
  requirePlugin(entries.size === manifest.files.length + 1 + Number(entries.has('manifest.sig')));
  for (const file of manifest.files) {
    const bytes = entries.get('payload/' + file.path);
    requirePlugin(bytes?.length === file.size && sha256(bytes) === file.sha256, 'digest-mismatch');
  }
  const views = readViews(manifest, entries);
  return { manifest, digest: sha256(bytes), views, bytes };
}

export type VerifiedPlugin = ReturnType<typeof verifyPackage>;
