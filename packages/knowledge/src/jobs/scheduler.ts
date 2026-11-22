import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { key } from '../ingest.ts';
import type { Candidate } from '../ingest.ts';
import type { KnowledgeStore } from '../store.ts';

const minute = 60_000;
const day = 1440 * minute;
const utcMinute = (now: number) => Math.floor(now / minute) * minute;
type Schedule = { id: string; zone: string; time: string; payload: string; state: string; since: number };
export type BiOccurrence = { job: string; schedule: string; candidate: Candidate };
type DispatchOccurrence = (occurrence: BiOccurrence) => 'queued' | 'awaiting_review' | 'blocked';

export class BiScheduler {
  private readonly db: DatabaseSync;
  private readonly store: KnowledgeStore;
  private readonly dispatch?: DispatchOccurrence;
  private readonly occupied?: (schedule: string) => boolean;

  constructor(db: DatabaseSync, store: KnowledgeStore, dispatch?: DispatchOccurrence, occupied?: (schedule: string) => boolean) {
    this.db = db;
    this.store = store;
    this.dispatch = dispatch;
    this.occupied = occupied;
    db.exec(`CREATE TABLE IF NOT EXISTS bi_schedules(id TEXT PRIMARY KEY, zone TEXT, time TEXT,
      payload TEXT, state TEXT, since INTEGER);
      CREATE TABLE IF NOT EXISTS bi_occurrences(schedule TEXT, wall TEXT, zone TEXT, utc INTEGER, job TEXT UNIQUE,
      payload TEXT, state TEXT, PRIMARY KEY(schedule,wall));`);
  }

  save(id: string, zone: string, time: string, input: Candidate, now = Date.now()) {
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time) || input?.vault?.kind !== 'bi') {
      throw new Error('Invalid BI schedule');
    }
    zoneClock(zone);
    this.db.prepare(`INSERT INTO bi_schedules VALUES (?,?,?,?,'draft',?)
      ON CONFLICT(id) DO UPDATE SET zone=excluded.zone,time=excluded.time,payload=excluded.payload,state='draft',
      since=excluded.since`).run(key(id), zone, time, JSON.stringify(input), now);
  }

  state(id: string, state: unknown, now = Date.now()) {
    if (!['active', 'paused', 'rejected', 'removed'].includes(String(state))) throw new Error('Invalid schedule state');
    this.db.prepare('UPDATE bi_schedules SET state=?,since=? WHERE id=? AND state<>?').run(String(state), now, key(id), String(state));
  }

  list() {
    return {
      schedules: this.db.prepare('SELECT id,zone,time,state,since,payload FROM bi_schedules ORDER BY id').all(),
      occurrences: this.db.prepare('SELECT schedule,wall,zone,utc,job,state FROM bi_occurrences ORDER BY utc DESC LIMIT 200').all(),
    };
  }

  runNow(id: string, now = Date.now()) {
    const schedule = this.db.prepare("SELECT * FROM bi_schedules WHERE id=? AND state IN ('active','paused')")
      .get(key(id)) as Schedule | undefined;
    if (!schedule) throw new Error('Schedule is unavailable');
    const clock = zoneClock(schedule.zone);
    const wall = clock(now).slice(0, 10) + 'T' + schedule.time;
    const job = this.admit(schedule, wall, utcMinute(now));
    this.recover();
    return job;
  }

  reconcile(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.admitDue(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.recover();
  }

  private admitDue(now: number) {
    const end = utcMinute(now);
    const previous = Number(this.db.prepare("SELECT next FROM cursor WHERE bot='scheduler'").get()?.next ?? end - day);
    if (previous <= end) {
      for (const schedule of this.db.prepare("SELECT * FROM bi_schedules WHERE state='active'").all() as Schedule[]) {
        const clock = zoneClock(schedule.zone);
        const expired = previous < end - day;
        if (expired && schedule.since <= end - day) {
          this.admit(schedule, 'expired-' + String(end - day), end - day, 'expired');
        }
        const first = Math.max(previous, end - day, Math.ceil(schedule.since / minute) * minute);
        const due = new Map<string, number>();
        for (let at = first; at <= end; at += minute) {
          const wall = clock(at);
          if (wall.slice(11) === schedule.time && !due.has(wall)) due.set(wall, at);
        }
        const latest = [...due.keys()].at(-1);
        const occupied = this.occupied?.(schedule.id);
        for (const [wall, at] of due) this.admit(schedule, wall, at, wall === latest && !occupied ? 'queued' : 'missed');
      }
      this.db.prepare(`INSERT INTO cursor VALUES ('scheduler',?)
        ON CONFLICT(bot) DO UPDATE SET next=MAX(next,excluded.next)`).run(end + minute);
    }
  }

  private admit(schedule: Schedule, wall: string, utc: number, state = 'queued') {
    const job = 'scheduled-' + createHash('sha256').update(JSON.stringify([schedule.id, wall])).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO bi_occurrences VALUES (?,?,?,?,?,?,?)')
      .run(schedule.id, wall, schedule.zone, utc, job, schedule.payload, state);
    return job;
  }

  private recover() {
    const rows = this.db.prepare("SELECT job,schedule,payload FROM bi_occurrences WHERE state='queued' ORDER BY utc,job").all();
    const update = this.db.prepare('UPDATE bi_occurrences SET state=? WHERE job=?');
    for (const row of rows) {
      const job = String(row.job);
      try {
        const candidate = JSON.parse(String(row.payload)) as Candidate;
        if (this.dispatch) {
          const state = this.dispatch({ job, schedule: String(row.schedule), candidate });
          if (state !== 'queued') update.run(state, job);
          continue;
        }
        this.store.enqueueBi(job, candidate, 'schedule');
        this.store.runBi(job);
        if (this.store.biCompleted(job)) update.run('awaiting_review', job);
      } catch {
        update.run('blocked', job);
      }
    }
  }
}

function zoneClock(zone: string) {
  if (!/^[A-Za-z]/.test(zone)) throw new Error('Expected an IANA time zone');
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (at: number) => format.format(at).replace(', ', 'T');
}
