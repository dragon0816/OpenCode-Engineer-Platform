import { unzipSync } from 'fflate';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseDocument, stringify } from 'yaml';
import { atRepo } from '../../../launcher/src/paths.ts';
import { HttpError } from '../http/errors.ts';
import { payloadPath } from '../plugins/zip.ts';
import { canonicalWorkspaceDirectory, checkDirectory, openWorkspaceFile } from './workspace.ts';

export const skillZipLimit = 16 * 1024 * 1024;
const expandedLimit = 32 * 1024 * 1024;
const perFileLimit = 8 * 1024 * 1024;
const skillTextLimit = 256 * 1024;
const maxFiles = 300;
const skillResourceLimit = 64 * 1024;
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const warnAbove = 20;
export const skillDiscovery = 'oep-skill-library';
const decoder = new TextDecoder('utf-8', { fatal: true });
type Files = Map<string, Uint8Array>;
type Skill = { name: string; description: string; instructions: string };
type StoredSkill = Skill & { source: string; bundled: number };
const invalidSkill = () => new HttpError(400, 'skill-package-invalid');
const readableResource = (name: string) => payloadPath(name) && name !== 'SKILL.md' && /\.(?:md|txt|json|csv|tsv|ya?ml|toml)$/i.test(name);

export function skillResourceArgs(args: Record<string, unknown>): args is { skill: string; resource: string } {
  return Object.keys(args).length === 2 && typeof args.skill === 'string' && args.skill.length <= 64 && skillName.test(args.skill) &&
    typeof args.resource === 'string' && readableResource(args.resource);
}

function parseSkill(files: Files): Skill {
  const readme = files.get('SKILL.md');
  if (!readme || readme.byteLength > skillTextLimit) throw invalidSkill();
  let text: string;
  try { text = decoder.decode(readme); }
  catch { throw invalidSkill(); }
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!frontmatter) throw new HttpError(400, 'skill-frontmatter-invalid');
  try {
    const document = parseDocument(frontmatter[1], { schema: 'core', uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML');
    const { name, description } = document.toJS({ maxAliasCount: 0 }) ?? {};
    if (typeof name !== 'string' || name.length > 64 || !skillName.test(name) || !payloadPath(name) ||
      typeof description !== 'string' || !description.trim() || [...description].length > 1024 ||
      !text.slice(frontmatter[0].length).trim()) throw new Error('Invalid skill fields');
    // Rebuild the runtime metadata to prevent imported settings from modifying OpenCode discovery.
    const resources = [...files].filter(([path, bytes]) => readableResource(path) && bytes.byteLength <= skillResourceLimit)
      .map(([path]) => path).sort().slice(0, 20);
    const hint = resources.length ? `\n\nUse oep_file_read with skill "${name}" and resource set to the relative path to read an installed reference.\n` +
      resources.map((path) => `- ${path}`).join('\n') + '\n' : '';
    return { name, description, instructions: `---\n${stringify({ name, description })}---\n${text.slice(frontmatter[0].length)}${hint}` };
  } catch { throw new HttpError(400, 'skill-frontmatter-invalid'); }
}

export function readSkillFolder(folder: string) {
  try {
    const root = canonicalWorkspaceDirectory(folder);
    const files: Files = new Map();
    let total = 0;
    let entries = 0;
    function visit(prefix: string) {
      checkDirectory(join(root, prefix), true);
      for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (++entries > maxFiles || !payloadPath(name)) throw invalidSkill();
        if (entry.isDirectory()) { visit(name + '/'); continue; }
        if (!entry.isFile()) throw invalidSkill();
        const { data } = openWorkspaceFile(root, name, Math.min(perFileLimit, expandedLimit - total));
        total += data.length;
        files.set(name, data);
      }
    }
    visit('');
    return files;
  } catch { throw invalidSkill(); }
}

export function readSkillZip(bytes: Uint8Array) {
  if (bytes.length > skillZipLimit) throw invalidSkill();
  try {
    let total = 0;
    const names = new Set<string>();
    const files = Object.entries(unzipSync(bytes, { filter({ name, originalSize }) {
      const directory = name.endsWith('/');
      const path = directory ? name.slice(0, -1) : name;
      const key = path.toLowerCase();
      total += originalSize;
      if (!payloadPath(path) || names.has(key) || names.size === maxFiles || originalSize > perFileLimit || total > expandedLimit ||
        path.split('/').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part.toLowerCase())) || directory && originalSize) {
        throw invalidSkill();
      }
      names.add(key);
      return !directory;
    } }));
    const root = files.some(([name]) => name === 'SKILL.md') ? '' : `${files[0]?.[0].split('/')[0]}/`;
    if (files.some(([name]) => !name.startsWith(root)) || !files.some(([name]) => name === root + 'SKILL.md')) throw invalidSkill();
    return new Map(files.map(([name, data]) => [name.slice(root.length), data]));
  } catch { throw invalidSkill(); }
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : undefined;
const workflowIdentity = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
function ref(value: unknown) {
  if (typeof value === 'string') {
    const match = /^([^/]+)\/([^@]+)@(.+)$/.exec(value);
    if (match) return ref({ namespace: match[1], name: match[2], version: match[3] });
  }
  const identity = record(value);
  if (typeof identity?.namespace === 'string' && workflowIdentity.test(identity.namespace) &&
    typeof identity.name === 'string' && workflowIdentity.test(identity.name) && typeof identity.version === 'string' &&
    identity.version.length <= 80 && versionPattern.test(identity.version)) return `${identity.namespace}/${identity.name}@${identity.version}`;
  return undefined;
}

export function readWorkflow(bytes: Uint8Array) {
  try {
    const definition = record(JSON.parse(decoder.decode(bytes)));
    const id = ref(record(definition?.metadata)?.identity);
    const { description, steps, parameters = [], kind = 'workflow' } = definition ?? {};
    if (!id || kind !== 'workflow' || typeof description !== 'string' || !description.trim() || !Array.isArray(steps) ||
      !steps.length || !steps.every((step) => ref(record(step)?.capability ?? step)) || !Array.isArray(parameters) ||
      !parameters.every((param) => typeof record(param)?.name === 'string')) throw new Error('Invalid workflow');
    return { id, description, steps, parameters, definition };
  } catch { throw new HttpError(400, 'workflow-package-invalid'); }
}

export class CapabilityLibrary {
  private readonly db: DatabaseSync;
  private readonly transaction: <T>(operation: () => T) => T;

  constructor(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
    this.db = db;
    this.transaction = transaction;
  }

  private saveSkill(files: Files, source: string, bundled: boolean) {
    const skill = parseSkill(files);
    const contents = JSON.stringify([...files].map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]));
    const result = this.db.prepare('INSERT OR IGNORE INTO installed_skills VALUES (?,?,?,?,?,?)')
      .run(skill.name, skill.description, source, Number(bundled), skill.instructions, contents);
    return { name: skill.name, inserted: Boolean(result.changes) };
  }

  seed() {
    if (this.db.prepare("SELECT 1 FROM capability_defaults WHERE name='skills-v1'").get()) return;
    const root = atRepo('apps/adapter/default-skills');
    const entries = JSON.parse(readFileSync(join(root, 'defaults.json'), 'utf8')) as { name: string; enabled: boolean; source?: string }[];
    this.transaction(() => {
      const marker = this.db.prepare("INSERT OR IGNORE INTO capability_defaults VALUES ('skills-v1')").run();
      if (!marker.changes) return;
      for (const entry of entries) {
        const files: Files = new Map();
        const rootSkill = join(root, entry.name);
        for (const file of readdirSync(rootSkill, { recursive: true, withFileTypes: true })) {
          if (!file.isFile()) continue;
          const path = join(file.parentPath, file.name);
          files.set(relative(rootSkill, path).replaceAll('\\', '/'), readFileSync(path));
        }
        const { name, inserted } = this.saveSkill(files, entry.source ?? 'AEP · Hermes Skill Pack', true);
        if (name !== entry.name) throw new Error('Bundled skill name mismatch');
        if (entry.enabled && inserted) this.enable('main', name, true);
      }
    });
  }

  install(files: Files, source: string) {
    if (!this.saveSkill(files, source, false).inserted) throw new HttpError(409, 'skill-already-installed');
  }

  list(assistants: readonly { id: string; name: string }[]) {
    const skills = this.db.prepare('SELECT name,description,source,bundled FROM installed_skills ORDER BY name').all() as Omit<StoredSkill, 'instructions'>[];
    const grants = this.db.prepare("SELECT capability_id AS name,agent_id AS id FROM agent_capabilities WHERE kind='skill' AND enabled=1")
      .all() as { name: string; id: string }[];
    return { skills: skills.map((skill) => ({ ...skill, enabledFor: grants.filter(({ name }) => name === skill.name).map(({ id }) => id) })),
      assistants, warningLimit: warnAbove };
  }

  enable(assistant: string, name: string, enabled: boolean) {
    const result = this.db.prepare(`INSERT INTO agent_capabilities(agent_id,kind,capability_id,enabled)
      SELECT a.id,'skill',s.name,? FROM agents a, installed_skills s WHERE a.id=? AND a.state='active' AND s.name=?
      ON CONFLICT(agent_id,kind,capability_id) DO UPDATE SET enabled=excluded.enabled`).run(Number(enabled), assistant, name);
    if (!result.changes) throw new HttpError(404, 'skill-or-assistant-missing');
  }

  remove(name: string) {
    this.transaction(() => {
      if (!this.db.prepare('DELETE FROM installed_skills WHERE name=?').run(name).changes) throw new HttpError(404, 'skill-or-assistant-missing');
      this.db.prepare("DELETE FROM agent_capabilities WHERE kind='skill' AND capability_id=?").run(name);
    });
  }

  grants(assistant: string) {
    return this.db.prepare(`SELECT s.name,s.instructions FROM installed_skills s JOIN agent_capabilities a ON a.capability_id=s.name
      WHERE a.kind='skill' AND a.agent_id=? AND a.enabled=1 ORDER BY s.name`).all(assistant) as Pick<Skill, 'name' | 'instructions'>[];
  }

  readResource(assistant: string, skill: string, resource: string) {
    if (!readableResource(resource)) return;
    const row = this.db.prepare(`SELECT s.files FROM installed_skills s JOIN agent_capabilities a ON a.capability_id=s.name
      WHERE a.kind='skill' AND a.agent_id=? AND a.enabled=1 AND s.name=?`).get(assistant, skill);
    if (!row) return;
    const contents = JSON.parse(String(row.files)) as [string, string][];
    const entry = contents.find(([name]) => name === resource);
    if (!entry) return;
    const bytes = Buffer.from(entry[1], 'base64');
    return bytes.length <= skillResourceLimit ? bytes : undefined;
  }

  workflows() {
    return this.db.prepare('SELECT definition FROM imported_workflows ORDER BY id').all()
      .map(({ definition }) => {
        const { definition: _manifest, ...preview } = JSON.parse(String(definition)) as ReturnType<typeof readWorkflow>;
        return preview;
      });
  }

  importWorkflow(bytes: Uint8Array) {
    const workflow = readWorkflow(bytes);
    const stored = JSON.stringify(workflow);
    this.db.prepare('INSERT OR IGNORE INTO imported_workflows VALUES (?,?)').run(workflow.id, stored);
    if (this.db.prepare('SELECT definition FROM imported_workflows WHERE id=?').get(workflow.id)?.definition !== stored) {
      throw new HttpError(409, 'workflow-already-imported');
    }
  }
}

export function projectSkills(workspace: string, skills: readonly Pick<Skill, 'name' | 'instructions'>[]) {
  const root = join(workspace, skillDiscovery);
  mkdirSync(root, { recursive: true });
  checkDirectory(root);
  let changed = false;
  for (const skill of skills) {
    const folder = join(root, skill.name);
    mkdirSync(folder, { recursive: true });
    checkDirectory(folder);
    const target = join(folder, 'SKILL.md');
    if (existsSync(target) && openWorkspaceFile(folder, 'SKILL.md', skillTextLimit + 8192).data.toString('utf8') === skill.instructions) continue;
    const temporary = target + '.' + randomUUID() + '.new';
    try {
      writeFileSync(temporary, skill.instructions, { flag: 'wx' });
      renameSync(temporary, target);
      changed = true;
    } finally { rmSync(temporary, { force: true }); }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && skillName.test(entry.name) && !skills.some(({ name }) => name === entry.name)) {
      const folder = join(root, entry.name);
      checkDirectory(folder);
      const target = join(folder, 'SKILL.md');
      if (existsSync(target)) { rmSync(target); changed = true; }
    }
  }
  return changed;
}
