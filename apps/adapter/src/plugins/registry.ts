import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import semver from 'semver';
import { checkDirectory, openWorkspaceFile } from '../runs/workspace.ts';
import { compatibleWith, digestPattern, pluginID, sha256, verifyPackage, version } from './package.ts';
import type { VerifiedPlugin } from './package.ts';
import { archiveLimit, PluginError, requirePlugin } from './zip.ts';
import { validatePythonDependencies } from './python.ts';

type State = 'enabled' | 'disabled' | 'integrity-failed';
type Package = { plugin_id: string; version: string; artifact: string; digest: string; description: string };
type Installation = Package & { previous_version: string | null; state: State; generation: string };
type Journal = { operation_id: string; plugin_id: string; operation: 'install' | 'uninstall'; version: string | null; retired_artifact?: string | null };
type Preview = { owner: string; expires: number; plugin: VerifiedPlugin; generation?: string; trustCurrent: boolean };
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/;
const installationQuery = `SELECT i.*, p.artifact, p.digest, p.description FROM plugin_installations i
  JOIN plugin_packages p USING(plugin_id, version)`;

function describe(plugin: VerifiedPlugin) {
  const { id, version, name, publisher, oepCompatibility, permissions, components } = plugin.manifest;
  const pages = components.pages.map(({ id }) => ({ id, title: plugin.views.find((view) => view.id === id)!.title }));
  const schemas = components.dataSchemas.map(({ id, version, entry }) => ({ id, version,
    digest: plugin.manifest.files.find(({ path }) => entry === path)!.sha256 }));
  const byID = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, 'en');
  const dataContract = JSON.stringify([schemas.sort(byID), [...components.collections].sort(byID), [...components.reviewTypes].sort(byID)]);
  return { id, version, digest: plugin.digest, name, publisher, oepCompatibility, permissions, pages, dataContract };
}

type Description = ReturnType<typeof describe>;
const description = (row: Package) => JSON.parse(row.description) as Description;

function samePermissions(a: Description['permissions'], b: Description['permissions']) {
  return a.dataScope === b.dataScope && a.modelBroker === b.modelBroker && a.sourceBroker === b.sourceBroker &&
    [...a.operations].sort().join() === [...b.operations].sort().join() && [...a.workers].sort().join() === [...b.workers].sort().join();
}

function ensureDirectory(path: string) {
  checkDirectory(dirname(path));
  if (!existsSync(path)) mkdirSync(path);
  checkDirectory(path);
}

function removeFile(path: string) {
  if (!existsSync(dirname(path))) return;
  checkDirectory(dirname(path));
  if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path);
}

export class PluginRegistry {
  private readonly db: DatabaseSync;
  private readonly oepVersion: string;
  private readonly root: string;
  private readonly packages: string;
  private readonly staging: string;
  private readonly previews = new Map<string, Preview>();
  onDeactivate?: (id: string) => void;

  constructor(db: DatabaseSync, dataRoot: string, oepVersion: string) {
    this.db = db;
    this.oepVersion = version(oepVersion);
    this.root = join(dataRoot, 'plugins');
    this.packages = join(this.root, 'packages');
    this.staging = join(this.root, 'staging');
  }

  private commit<T>(work: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private installation(id: string) {
    return this.db.prepare(installationQuery + ' WHERE i.plugin_id = ?').get(id) as Installation | undefined;
  }

  private installed(id: string) {
    const row = this.installation(id);
    requirePlugin(row, 'not-installed');
    return row;
  }

  private package(id: string, selected: string) {
    return this.db.prepare('SELECT * FROM plugin_packages WHERE plugin_id = ? AND version = ?').get(id, selected) as Package | undefined;
  }

  private artifact(id: string, selected: string, artifact: string) {
    requirePlugin(pluginID.test(id) && uuid.test(artifact));
    return join(this.packages, id, version(selected), artifact + '.oepplugin');
  }

  private readArtifact(row: Package, checkDigest = true) {
    const path = this.artifact(row.plugin_id, row.version, row.artifact);
    const { data } = openWorkspaceFile(dirname(path), row.artifact + '.oepplugin', archiveLimit);
    requirePlugin(!checkDigest || sha256(data) === row.digest, 'digest-mismatch');
    const plugin = verifyPackage(data);
    requirePlugin(plugin.manifest.id === row.plugin_id && plugin.manifest.version === row.version, 'version-conflict');
    return plugin;
  }

  private checked(row: Package) {
    try { return this.readArtifact(row); }
    catch {
      const changed = this.db.prepare(`UPDATE plugin_installations SET state = 'integrity-failed', generation = ?
        WHERE plugin_id = ? AND version = ? AND state <> 'integrity-failed'`).run(randomUUID(), row.plugin_id, row.version);
      if (changed.changes) this.onDeactivate?.(row.plugin_id);
      throw new PluginError('integrity-failed');
    }
  }

  private cleanup(journal: Journal) {
    const { operation_id: operationId, plugin_id: id, version: selected } = journal;
    requirePlugin(uuid.test(operationId) && pluginID.test(id));
    if (journal.operation === 'install') {
      requirePlugin(selected);
      removeFile(join(this.staging, operationId + '.oepplugin'));
      if (this.package(id, selected)?.artifact !== operationId) removeFile(this.artifact(id, selected, operationId));
      else if (journal.retired_artifact) removeFile(this.artifact(id, selected, journal.retired_artifact));
    } else {
      requirePlugin(journal.operation === 'uninstall' && !this.installation(id));
      // Package rows remain as a cleanup worklist until their own file has been removed.
      const records = this.db.prepare('SELECT * FROM plugin_packages WHERE plugin_id = ?').all(id) as Package[];
      for (const row of records) removeFile(this.artifact(id, row.version, row.artifact));
      this.db.prepare('DELETE FROM plugin_packages WHERE plugin_id = ?').run(id);
    }
    this.db.prepare('DELETE FROM plugin_operations WHERE operation_id = ?').run(operationId);
  }

  recover() {
    for (const journal of this.db.prepare('SELECT * FROM plugin_operations').all() as Journal[]) {
      try { this.cleanup(journal); }
      catch { /* Keep the journal so a later startup can retry safe cleanup. */ }
    }
    for (const row of this.db.prepare(installationQuery).all() as Installation[]) {
      try { this.checked(row); }
      catch (error) { if (!(error instanceof PluginError)) throw error; }
    }
  }

  private publicDescription({ dataContract: _contract, ...details }: Description) {
    return { ...details, compatible: compatibleWith(this.oepVersion, details.oepCompatibility), oepVersion: this.oepVersion };
  }

  list() {
    return (this.db.prepare(installationQuery + ' ORDER BY i.plugin_id').all() as Installation[]).map((row) => {
      const previous = row.previous_version && this.package(row.plugin_id, row.previous_version);
      return { ...this.publicDescription(description(row)), status: row.state,
        previousVersion: row.previous_version, previousCompatible: previous ? compatibleWith(this.oepVersion, description(previous).oepCompatibility) : null };
    });
  }

  private createPreview(plugin: VerifiedPlugin, owner: string, row: Installation | undefined, trustCurrent: boolean) {
    const now = Date.now();
    for (const [id, preview] of this.previews) if (preview.expires <= now) this.previews.delete(id);
    if (this.previews.size === 4) this.previews.delete(this.previews.keys().next().value!);
    const token = randomUUID();
    this.previews.set(token, { owner, expires: now + 5 * 60_000, plugin, generation: row?.generation, trustCurrent });
    return { ...this.publicDescription(describe(plugin)), token, currentVersion: row?.version ?? null,
      previousPermissions: row && description(row).permissions, trustCurrent };
  }

  preview(bytes: Buffer, owner: string) {
    const plugin = verifyPackage(bytes);
    return this.createPreview(plugin, owner, this.installation(plugin.manifest.id), false);
  }

  private requireCompatibility(range: string, allowIncompatible: boolean) {
    requirePlugin(allowIncompatible || compatibleWith(this.oepVersion, range), 'compatibility-consent');
  }

  private acceptCurrent(row: Installation, plugin: VerifiedPlugin) {
    validatePythonDependencies(plugin);
    const current = describe(plugin);
    requirePlugin(description(row).dataContract === current.dataContract, 'migration-unsupported');
    this.commit(() => {
      this.db.prepare('UPDATE plugin_packages SET digest = ?, description = ? WHERE plugin_id = ? AND version = ?')
        .run(plugin.digest, JSON.stringify(current), row.plugin_id, row.version);
      this.db.prepare("UPDATE plugin_installations SET state = 'enabled', generation = ? WHERE plugin_id = ?").run(randomUUID(), row.plugin_id);
    });
    this.onDeactivate?.(row.plugin_id);
  }

  trustCurrent(id: string, owner: string) {
    const row = this.installed(id);
    requirePlugin(row.state === 'integrity-failed', 'version-conflict');
    let plugin;
    try { plugin = this.readArtifact(row, false); }
    catch { throw new PluginError('reinstall-required'); }
    if (!samePermissions(description(row).permissions, plugin.manifest.permissions) ||
      !compatibleWith(this.oepVersion, plugin.manifest.oepCompatibility)) {
      return this.createPreview(plugin, owner, row, true);
    }
    this.acceptCurrent(row, plugin);
  }

  install(token: string, consent: boolean, allowIncompatible: boolean, owner: string) {
    const preview = this.previews.get(token);
    requirePlugin(consent === true, 'consent-required');
    requirePlugin(preview && preview.owner === owner && preview.expires > Date.now(), 'preview-expired');
    const { plugin } = preview;
    this.requireCompatibility(plugin.manifest.oepCompatibility, allowIncompatible);
    this.previews.delete(token);
    const { id, version: selected } = plugin.manifest;
    const row = this.installation(id);
    requirePlugin(preview.generation === row?.generation, 'preview-expired');
    if (preview.trustCurrent) {
      requirePlugin(row?.state === 'integrity-failed', 'preview-expired');
      const latest = this.readArtifact(row, false);
      requirePlugin(latest.digest === plugin.digest, 'preview-expired');
      this.acceptCurrent(row, latest);
      return;
    }
    requirePlugin(!this.db.prepare('SELECT 1 FROM plugin_operations WHERE plugin_id = ?').get(id), 'operation-pending');
    const tracked = this.package(id, selected);
    const repairing = row?.version === selected && row.state === 'integrity-failed';
    if (tracked && !repairing) {
      requirePlugin(tracked.digest === plugin.digest && row?.version === selected, 'version-conflict');
      this.checked(row);
      return;
    }
    const details = describe(plugin);
    validatePythonDependencies(plugin);
    if (row) {
      requirePlugin(repairing || semver.gt(selected, row.version), 'version-conflict');
      if (row.state !== 'integrity-failed') this.checked(row);
      requirePlugin(description(row).dataContract === details.dataContract, 'migration-unsupported');
    }
    this.installArchive(plugin, details, row, repairing ? tracked : undefined);
    if (row) this.onDeactivate?.(id);
  }

  private installArchive(plugin: VerifiedPlugin, details: Description, row?: Installation, repair?: Package) {
    const { id, version: selected } = details;
    const operationId = randomUUID();
    const target = this.artifact(id, selected, operationId);
    for (const folder of [this.root, this.packages, this.staging, join(this.packages, id), dirname(target)]) ensureDirectory(folder);
    const journal: Journal = { operation_id: operationId, plugin_id: id, operation: 'install', version: selected, retired_artifact: repair?.artifact };
    this.db.prepare("INSERT INTO plugin_operations VALUES (?, ?, 'install', ?, ?)").run(operationId, id, selected, repair?.artifact ?? null);
    const scratch = join(this.staging, operationId + '.oepplugin');
    try {
      writeFileSync(scratch, plugin.bytes, { flag: 'wx' });
      const staged = openWorkspaceFile(this.staging, operationId + '.oepplugin', archiveLimit);
      requirePlugin(staged.identity.sha256 === plugin.digest, 'digest-mismatch');
      checkDirectory(dirname(target));
      renameSync(scratch, target);
      this.commit(() => {
        this.db.prepare(`INSERT INTO plugin_packages VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(plugin_id, version) DO UPDATE SET artifact = excluded.artifact, digest = excluded.digest,
          description = excluded.description`).run(id, selected, operationId, plugin.digest, JSON.stringify(details));
        this.db.prepare(`INSERT INTO plugin_installations VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(plugin_id) DO UPDATE SET version = excluded.version, previous_version = excluded.previous_version,
          state = excluded.state, generation = excluded.generation`).run(id, selected, repair ? row!.previous_version : row?.version ?? null,
          row?.state === 'disabled' ? 'disabled' : 'enabled', randomUUID());
        if (!repair) this.db.prepare('DELETE FROM plugin_operations WHERE operation_id = ?').run(operationId);
      });
    } catch (error) {
      try { this.cleanup(journal); }
      catch { /* Recovery owns any files that are still present. */ }
      throw error;
    }
    if (repair) {
      try { this.cleanup(journal); }
      catch { /* Startup will retry cleanup if the old artifact is locked. */ }
    }
  }

  enable(id: string, allowIncompatible: boolean) {
    const row = this.installed(id);
    const plugin = this.checked(row);
    requirePlugin(row.state !== 'integrity-failed', 'integrity-failed');
    this.requireCompatibility(plugin.manifest.oepCompatibility, allowIncompatible);
    this.db.prepare("UPDATE plugin_installations SET state = 'enabled', generation = ? WHERE plugin_id = ?").run(randomUUID(), id);
    this.onDeactivate?.(id);
  }

  disable(id: string) {
    this.installed(id);
    this.db.prepare("UPDATE plugin_installations SET state = 'disabled', generation = ? WHERE plugin_id = ? AND state = 'enabled'").run(randomUUID(), id);
    this.onDeactivate?.(id);
  }

  rollback(id: string, allowIncompatible: boolean) {
    const row = this.installed(id);
    const prior = row.previous_version && this.package(id, row.previous_version);
    requirePlugin(prior, 'rollback-unavailable');
    let plugin;
    try { plugin = this.readArtifact(prior); }
    catch { throw new PluginError('rollback-unavailable'); }
    this.requireCompatibility(plugin.manifest.oepCompatibility, allowIncompatible);
    // Upgrades and repairs preserve the declared data contract.
    this.db.prepare(`UPDATE plugin_installations SET version = ?, previous_version = ?, state = ?, generation = ? WHERE plugin_id = ?`)
      .run(prior.version, row.version, row.state === 'integrity-failed' ? 'disabled' : row.state, randomUUID(), id);
    this.onDeactivate?.(id);
  }

  uninstall(id: string) {
    this.installed(id);
    requirePlugin(!this.db.prepare('SELECT 1 FROM plugin_operations WHERE plugin_id = ?').get(id), 'operation-pending');
    const operationId = randomUUID();
    this.commit(() => {
      this.db.prepare("INSERT INTO plugin_operations VALUES (?, ?, 'uninstall', NULL, NULL)").run(operationId, id);
      this.db.prepare('DELETE FROM plugin_installations WHERE plugin_id = ?').run(id);
    });
    this.onDeactivate?.(id);
    try { this.cleanup({ operation_id: operationId, plugin_id: id, operation: 'uninstall', version: null }); }
    catch { return { cleanupPending: true }; }
    return { cleanupPending: false };
  }

  active(id: string, expectedDigest: string) {
    const row = this.installed(id);
    requirePlugin(row.state === 'enabled', 'disabled');
    requirePlugin(digestPattern.test(expectedDigest) && row.digest === expectedDigest, 'preview-expired');
    return { plugin: this.checked(row), generation: row.generation };
  }

  current(id: string, generation: string) {
    const row = this.installation(id);
    return row?.state === 'enabled' && row.generation === generation;
  }

  page(id: string, pageID: string, expectedDigest: string) {
    const { plugin } = this.active(id, expectedDigest);
    requirePlugin(plugin.manifest.components.pages.some(({ id }) => id === pageID), 'page-not-found');
    return plugin.views.find(({ id }) => id === pageID)!;
  }
}
