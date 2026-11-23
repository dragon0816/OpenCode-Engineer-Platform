import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';
import type { Classification } from './delegation-ledger.ts';

export type ReferenceIdentity = { key: string[]; size?: number; modified?: string; changed?: string; sha256?: string };
export type LocalReference = { id: string; revision: string; path: string; name: string; directory: boolean; mime: string;
  identity: ReferenceIdentity; hash: string; classification: Classification; createdAt: number };

export function migrateReferences(db: DatabaseSync) {
  db.exec(readFileSync(atRepo('apps/adapter/migrations/010_local_references.sql'), 'utf8'));
}

export function verifyReferences(db: DatabaseSync) {
  db.prepare('SELECT id,session_id,revision,record,revoked FROM local_references');
  db.prepare('SELECT reference_id,member,identity FROM local_reference_members');
  db.prepare('SELECT reference_id,event,identity_hash,chunk_hash,at FROM local_reference_audit');
}

export class ReferenceLedger {
  private readonly db: DatabaseSync;
  private readonly atomic: <T>(work: () => T) => T;

  constructor(db: DatabaseSync, atomic: <T>(work: () => T) => T) {
    this.db = db;
    this.atomic = atomic;
  }

  get(session: string, id: string) {
    const row = this.db.prepare('SELECT record FROM local_references WHERE session_id=? AND id=? AND revoked=0').get(session, id);
    return row ? JSON.parse(String(row.record)) as LocalReference : undefined;
  }

  list(session: string) {
    return this.db.prepare('SELECT record FROM local_references WHERE session_id=? AND revoked=0 ORDER BY rowid').all(session)
      .map(({ record }) => JSON.parse(String(record)) as LocalReference);
  }

  protectedLocations() {
    return this.db.prepare(`SELECT record FROM local_references WHERE json_extract(record,'$.classification')='confidential'
      OR session_id IN (SELECT s.session_id FROM session_ownership s JOIN agent_workspaces w ON w.id=s.workspace_id
        WHERE w.classification='confidential')`).all().map(({ record }) => JSON.parse(String(record)) as LocalReference);
  }

  add(session: string, records: LocalReference[]) {
    this.atomic(() => {
      for (const file of records) {
        this.db.prepare('INSERT INTO local_references (id,session_id,revision,record) VALUES (?,?,?,?)')
          .run(file.id, session, file.revision, JSON.stringify(file));
        this.audit(file, 'attach');
      }
    });
  }

  replace(session: string, before: LocalReference, after: LocalReference, event: 'classify' | 'reconfirm') {
    return this.atomic(() => {
      if (!this.db.prepare('UPDATE local_references SET revision=?,record=? WHERE session_id=? AND id=? AND revision=? AND revoked=0')
        .run(after.revision, JSON.stringify(after), session, before.id, before.revision).changes) return false;
      if (event === 'reconfirm') this.db.prepare('DELETE FROM local_reference_members WHERE reference_id=?').run(before.id);
      this.audit(after, event);
      return true;
    });
  }

  revoke(session: string, file: LocalReference) {
    return this.atomic(() => {
      if (!this.db.prepare('UPDATE local_references SET revoked=1 WHERE session_id=? AND id=? AND revision=? AND revoked=0')
        .run(session, file.id, file.revision).changes) return false;
      this.db.prepare('DELETE FROM local_reference_members WHERE reference_id=?').run(file.id);
      this.audit(file, 'revoke');
      return true;
    });
  }

  member(id: string, key: string) {
    const row = this.db.prepare('SELECT identity FROM local_reference_members WHERE reference_id=? AND member=?').get(id, key);
    return row ? JSON.parse(String(row.identity)) as ReferenceIdentity : undefined;
  }

  recordAccess(session: string, file: LocalReference, event: 'read' | 'list' | 'open',
    member?: { key: string; identity: ReferenceIdentity; hash: string }, chunk?: string) {
    return this.atomic(() => {
      if (this.get(session, file.id)?.revision !== file.revision) return false;
      if (member) {
        const encoded = JSON.stringify(member.identity);
        this.db.prepare('INSERT OR IGNORE INTO local_reference_members VALUES (?,?,?)').run(file.id, member.key, encoded);
        const recorded = this.db.prepare('SELECT identity FROM local_reference_members WHERE reference_id=? AND member=?')
          .get(file.id, member.key)?.identity;
        if (recorded !== encoded) return false;
      }
      this.audit(file, event, member?.hash, chunk);
      return true;
    });
  }

  private audit(file: LocalReference, event: string, hash = file.hash, chunk?: string) {
    this.db.prepare('INSERT INTO local_reference_audit (reference_id,event,identity_hash,chunk_hash,at) VALUES (?,?,?,?,?)')
      .run(file.id, event, hash, chunk ?? null, Date.now());
  }
}
