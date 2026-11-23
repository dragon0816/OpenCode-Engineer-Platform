import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyKnowledgePath } from '../../../launcher/src/knowledge.ts';
import { canonical, record, string, validateSnapshot, type Snapshot } from '../../../../packages/knowledge/src/snapshot.ts';
import { checkDirectory } from '../runs/workspace.ts';
import { defaults, type PipelineSettings } from './pipeline-settings.ts';

export type Workspace = { id: string; title: string; allowModel: boolean; schema: Snapshot['schema']; version: number;
  conflicts: number; snapshot?: Snapshot };

export class BiWorkspaces {
  readonly root: string;
  private database?: DatabaseSync;

  constructor(dataRoot: string) { this.root = join(dataRoot, 'plugin-data', 'oep.bi-knowledge'); }

  private db() {
    if (this.database) return this.database;
    const parent = dirname(this.root);
    checkDirectory(dirname(parent));
    mkdirSync(parent, { recursive: true });
    checkDirectory(parent);
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, 'workspaces.sqlite');
    verifyKnowledgePath(path);
    const database = new DatabaseSync(path);
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS stage_settings (target TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS question_sets (target TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY(target, name)) STRICT;`);
    } catch (error) { database.close(); throw error; }
    return this.database = database;
  }

  close() { this.database?.close(); }

  settings(target: string): PipelineSettings {
    const row = this.db().prepare('SELECT body FROM stage_settings WHERE target=?').get(target);
    return row ? { ...defaults, ...JSON.parse(String(row.body)) } : defaults;
  }

  configure(target: string, settings: PipelineSettings, saveQuestions = false) {
    const db = this.db();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO stage_settings VALUES (?,?) ON CONFLICT(target) DO UPDATE SET body=excluded.body`)
        .run(target, JSON.stringify(settings));
      if (saveQuestions) db.prepare(`INSERT INTO question_sets VALUES (?,?,?)
        ON CONFLICT(target,name) DO UPDATE SET body=excluded.body`).run(target, settings.testing.name, JSON.stringify(settings.testing));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  questionSets(target: string) {
    return this.db().prepare('SELECT name FROM question_sets WHERE target=? ORDER BY name').all(target).map(({ name }) => String(name));
  }

  testing(target: string, name: string) {
    const row = this.db().prepare('SELECT body FROM question_sets WHERE target=? AND name=?').get(target, name);
    if (!row) throw new Error('Unknown benchmark question set');
    return JSON.parse(String(row.body)) as PipelineSettings['testing'];
  }

  list() {
    return this.db().prepare(`SELECT json_remove(body,'$.snapshot') AS body FROM workspaces ORDER BY rowid DESC`).all()
      .map(({ body }) => JSON.parse(String(body)) as Workspace);
  }

  get(id: string) {
    const row = this.db().prepare('SELECT body FROM workspaces WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as Workspace : undefined;
  }

  create(title: string, schema: Snapshot['schema'], allowModel: boolean, snapshot?: Snapshot, conflicts = 0) {
    const id = 'bi-work-' + randomUUID();
    const item: Workspace = { id, title, schema, allowModel, version: 0, conflicts,
      ...(snapshot && { snapshot: { ...snapshot, vault: { ...snapshot.vault, id, title } } }) };
    this.db().prepare('INSERT INTO workspaces VALUES (?,?)').run(id, JSON.stringify(item));
    return item;
  }

  save(workspace: Workspace, version: number) {
    const next = { ...workspace, version: version + 1 };
    const result = this.db().prepare("UPDATE workspaces SET body=? WHERE id=? AND json_extract(body,'$.version')=?")
      .run(JSON.stringify(next), workspace.id, version);
    if (result.changes !== 1) throw new Error('BI working draft changed');
    return next;
  }

  edit(id: string, version: unknown, cardId: unknown, title: unknown, value: unknown) {
    const workspace = this.get(id);
    if (!workspace?.snapshot || workspace.version !== version) throw new Error('BI working draft changed');
    const { snapshot } = workspace;
    const card = snapshot.cards.find(({ id }) => id === cardId);
    if (!card) throw new Error('Unknown BI card');
    card.title = string(title, 'card title', 300).trim();
    const fields = record(value, 'card fields');
    if (Buffer.byteLength(canonical(fields)) > 32_000) throw new Error('BI card exceeds the edit limit');
    const changed = new Set([...Object.keys(card.fields), ...Object.keys(fields)].filter(field =>
      canonical(Object.hasOwn(fields, field) ? fields[field] : null) !== canonical(Object.hasOwn(card.fields, field) ? card.fields[field] : null)));
    const removed = new Set<string>();
    if (snapshot.repository?.evidence) snapshot.repository.evidence = snapshot.repository.evidence.filter(row => {
      if (row.card_id !== card.id || !changed.has(String(row.field))) return true;
      for (const id of Array.isArray(row.passageIds) ? row.passageIds : []) removed.add(String(id));
      return false;
    });
    for (const field of changed) {
      const ids = card.fieldProvenance?.[field];
      if (Array.isArray(ids)) for (const id of ids) removed.add(String(id));
      if (card.fieldProvenance) delete card.fieldProvenance[field];
      if (card.fieldStates) delete card.fieldStates[field];
    }
    card.fields = fields;
    snapshot.passages = snapshot.passages.filter(({ id }) => !removed.has(id));
    snapshot.relationships = snapshot.relationships.filter(({ from, provenance }) => from !== card.id ||
      !changed.has(String(provenance?.sourceField ?? provenance?.source_field)));
    validateSnapshot(snapshot);
    return this.save(workspace, workspace.version);
  }
}
