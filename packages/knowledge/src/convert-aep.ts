import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { canonical, invalid, record, rows, sha256, snapshotFormat, string, validateSnapshot } from './snapshot.ts';
import type { Card, Snapshot, Source } from './snapshot.ts';

export const maxSnapshotBytes = 32 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function localPath(path: string, directory: boolean) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  const actual = realpathSync.native(absolute);
  const equal = process.platform === 'win32' ? actual.toLowerCase() === absolute.toLowerCase() : actual === absolute;
  if (!equal || (directory ? !stat.isDirectory() : !stat.isFile())) invalid('local path');
  return { absolute, stat };
}

export function readLocal(path: string, max = maxSnapshotBytes) {
  const { absolute, stat } = localPath(path, false);
  if (stat.size > max) invalid('input size');
  const bytes = readFileSync(absolute);
  if (bytes.length > max) invalid('input size');
  return bytes;
}

function decodeJson(bytes: Uint8Array) {
  try { return JSON.parse(decoder.decode(bytes)) as unknown; }
  catch { return invalid('JSON'); }
}

function code(value: unknown, location: string) { return string(value, location, 192); }
function schemaDocument(id: string, version: string, document: Record<string, unknown>) {
  return { id, version, document, sha256: sha256(canonical(document)) };
}

function addPassages(snapshot: Snapshot, card: Card, sourceId: string, locator: string, text: string) {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 3600, text.length);
    if (end < text.length) {
      const line = text.lastIndexOf('\n', end - 1);
      if (line > start + 1800) end = line + 1;
      if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const chunk = text.slice(start, end);
    const id = sha256(canonical([card.id, locator, start]));
    if (chunk.trim()) snapshot.passages.push({ id, cardId: card.id, sourceId,
      locator: `${locator}#chars=${start}-${end}`, text: chunk, sha256: sha256(chunk) });
    start = end;
  }
}

function convertBI(input: Record<string, unknown>, bytes: Buffer): Snapshot {
  const verified = spawnSync(process.env.OEP_PYTHON || 'python', ['-I',
    fileURLToPath(new URL('../../../scripts/knowledge/verify-aep-bi.py', import.meta.url))],
  { input: bytes, stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000, windowsHide: true });
  if (verified.error) throw new Error('AEP BI checksum validation could not run (Python 3 is required)');
  if (verified.status !== 0) invalid('AEP BI digest/publication');
  const publication = record(input.publication, 'AEP BI publication');
  const schema = record(input.schema, 'AEP BI schema');
  const document = record(schema.document, 'AEP BI schema document');
  const revision = code(publication.version, 'publication version');
  const snapshot: Snapshot = {
    format: snapshotFormat, status: 'published',
    vault: { id: `${code(publication.namespace, 'namespace')}/${code(publication.name, 'publication name')}`,
      title: code(input.dataset, 'dataset'), kind: 'bi' },
    publication: { revision, publishedAt: code(publication.published_at, 'publication time'),
      publisher: code(publication.published_by, 'publisher'),
      ...(publication.base_version != null ? { parent: code(publication.base_version, 'base version') } : {}) },
    schema: schemaDocument(code(schema.id, 'schema ID'), code(schema.version, 'schema version'), document),
    cards: [], sources: [], relationships: [], passages: [],
  };
  const schemaTypes = new Map(rows(document.types, 'AEP BI types').map((value) => {
    const type = record(value, 'AEP BI type');
    return [type.name, new Map(rows(type.fields, 'AEP BI type fields').map((item) => {
      const field = record(item, 'AEP BI schema field');
      return [field.name, field] as const;
    }))] as const;
  }));
  const origins = new Map<string, Source>();
  const edges = new Map<string, { from: string; to: string; kind: string }>();
  const ids = new Set<string>();
  const values = rows(input.cards, 'AEP BI cards').map((value) => record(value, 'AEP BI card'));
  for (const item of values) ids.add(code(item.id, 'card ID'));
  for (const item of values) {
    const card: Card = { id: code(item.id, 'card ID'), type: code(item.entity_type, 'card entity type'),
      key: string(item.canonical_key, 'card canonical key'), title: string(item.name, 'card name'),
      version: String(item.version), fields: record(item.fields, 'card fields') };
    if (typeof item.version !== 'number' || !Number.isSafeInteger(item.version) || item.version < 1) invalid('AEP BI card version');
    snapshot.cards.push(card);
    for (const [name, item] of Object.entries(card.fields)) {
      const field = record(item, 'AEP BI field');
      if (!Object.hasOwn(field, 'value') || typeof field.ref !== 'string') invalid('AEP BI field value/ref');
      const ref = field.ref || `AEP BI publication ${snapshot.vault.id}`;
      const sourceId = sha256(ref);
      if (!origins.has(sourceId)) origins.set(sourceId, { id: sourceId, ref, version: revision });
      if (field.value !== null) {
        const display = typeof field.value === 'string' ? field.value : canonical(field.value);
        addPassages(snapshot, card, sourceId, `published-card:${card.id}/field:${name}`,
          `${card.title} (${card.key}) — ${name}: ${display}`);
      }
      const definition = schemaTypes.get(card.type)?.get(name);
      if (definition?.kind === 'link' || definition?.kind === 'linklist') {
        const targets = Array.isArray(field.value) ? field.value : [field.value];
        for (const target of targets) {
          if (typeof target !== 'string' || !ids.has(target)) continue;
          const kind = typeof definition.relation_type === 'string' && definition.relation_type
            ? definition.relation_type : `has_${name}`;
          const edge = { from: card.id, to: target, kind };
          edges.set(canonical(edge), edge);
        }
      }
    }
  }
  snapshot.sources = [...origins.values()];
  snapshot.relationships = [...edges.values()];
  return snapshot;
}

function readWiki(root: string) {
  const folder = localPath(root, true).absolute;
  const files = new Map<string, Buffer>();
  let available = maxSnapshotBytes;
  function add(name: string) {
    if (files.size >= 10_000) invalid('Wiki file count');
    const bytes = readLocal(join(folder, name), available);
    files.set(name, bytes);
    available -= bytes.length;
  }
  function visit(name: string, depth: number) {
    if (depth > 32) invalid('Wiki folder depth');
    const path = localPath(join(folder, name), true).absolute;
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = `${name}/${item.name}`;
      if (item.isDirectory()) visit(child, depth + 1);
      else if (item.isFile()) {
        if (name.startsWith('raw') || item.name.endsWith('.md')) add(child);
      } else invalid('Wiki non-regular entry');
    }
  }
  visit('raw', 0);
  visit('wiki', 0);
  for (const name of ['index.md', 'log.md', 'decisions.md']) add(name);
  return files;
}

function fileDigest(files: Map<string, Buffer>, include: (name: string) => boolean) {
  const hash = createHash('sha256');
  const names = [...files.keys()].filter(include).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of names) hash.update(name).update('\0').update(files.get(name)!).update('\0');
  return hash.digest('hex');
}

function convertWiki(manifest: Record<string, unknown>, files: Map<string, Buffer>): Snapshot {
  const metadata = record(manifest.metadata, 'Wiki metadata');
  const identity = record(metadata.identity, 'Wiki identity');
  const approval = record(metadata.business_approval, 'Wiki approval');
  if (manifest.kind !== 'knowledge' || approval.status !== 'approved') invalid('Wiki publication approval');
  const raw = (name: string) => name.startsWith('raw/');
  const evidence = (name: string) => name.endsWith('.md') && (!raw(name) || !name.includes('/assets/'));
  if (fileDigest(files, raw) !== manifest.raw_sha256 || fileDigest(files, evidence) !== manifest.content_sha256 ||
      sha256(files.get('decisions.md')!) !== manifest.decisions_sha256) invalid('Wiki publication digest');
  const revision = code(identity.version, 'Wiki revision');
  const validation = /-(\d{8})$/.exec(code(approval.evidence, 'Wiki approval evidence'));
  const day = validation?.[1];
  if (!day) invalid('Wiki publication date');
  const snapshot: Snapshot = {
    format: snapshotFormat, status: 'published',
    vault: { id: `${code(identity.namespace, 'Wiki namespace')}/${code(identity.name, 'Wiki name')}`,
      title: code(manifest.domain, 'Wiki domain'), kind: 'wiki' },
    publication: { revision, publisher: code(approval.reviewer, 'Wiki reviewer'),
      publishedAt: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z` },
    schema: schemaDocument('aep-wiki-markdown', '1', { domain: manifest.domain }),
    cards: [], sources: [], relationships: [], passages: [],
  };
  const pages = new Map<string, Card[]>();
  const markdown = new Map<string, string>();
  for (const [name, bytes] of files) {
    if (!name.includes('/') || !evidence(name)) continue;
    const id = sha256(name);
    const title = basename(name, '.md');
    const card: Card = { id, title, type: raw(name) ? 'raw' : 'wiki', key: name, version: revision, fields: {} };
    snapshot.cards.push(card);
    snapshot.sources.push({ id, ref: name, version: revision, sha256: sha256(bytes) });
    const text = decoder.decode(bytes);
    markdown.set(name, text);
    addPassages(snapshot, card, id, name, text);
    for (const key of [title, name.slice(0, -3)]) pages.set(key, [...(pages.get(key) ?? []), card]);
  }
  for (const [name, text] of markdown) {
    const links = new Set([...text.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map((match) => match[1].replace(/\.md$/, '')));
    for (const link of links) {
      const target = pages.get(link);
      if (target?.length === 1) snapshot.relationships.push({ from: sha256(name), to: target[0].id, kind: 'wiki-link' });
    }
  }
  return snapshot;
}

export function publishedInput(path: string, wikiRoot?: string) {
  let original = readLocal(path);
  const bytes = original[0] === 0x1f && original[1] === 0x8b
    ? gunzipSync(original, { maxOutputLength: maxSnapshotBytes }) : original;
  const input = record(decodeJson(bytes), 'root');
  let snapshot: unknown = input;
  if (wikiRoot !== undefined) {
    const files = readWiki(wikiRoot);
    snapshot = convertWiki(input, files);
    original = Buffer.from(canonical({ manifest: original.toString('base64'),
      files: Object.fromEntries([...files].map(([name, content]) => [name, content.toString('base64')])) }));
  } else if (input.format === 'aep-bi-dataset-snapshot/1') snapshot = convertBI(input, bytes);
  return { snapshot: validateSnapshot(snapshot), original };
}
