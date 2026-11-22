import type { DatabaseSync } from 'node:sqlite';
import type { Binding, Delivery, Destination, InboundEnvelope, Lane, OutboundMessage } from './transport.ts';

export const channelSpoolSchema = `
  CREATE TABLE channel_cursors (
    account_id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE channel_inbound (
    account_id TEXT NOT NULL, event_key TEXT NOT NULL, conversation_key TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(binding_revision > 0), agent_id TEXT NOT NULL,
    received_at INTEGER NOT NULL, first_attempt_at INTEGER, status TEXT NOT NULL
      CHECK(status IN ('pending','handed_off','handled','rejected','failed')),
    payload TEXT CHECK(json_valid(payload)), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    due_at INTEGER NOT NULL DEFAULT 0, work_id TEXT, reason_code TEXT,
    lane TEXT NOT NULL CHECK(lane IN ('work','command')),
    CHECK(status <> 'rejected' OR (payload IS NULL AND reason_code IS NOT NULL)),
    PRIMARY KEY(account_id, event_key)
  ) STRICT;
  CREATE INDEX channel_inbound_due ON channel_inbound(status,due_at,account_id);
  CREATE INDEX channel_inbound_conversation ON channel_inbound(account_id,conversation_key,binding_revision,lane,status);
  CREATE TABLE channel_outbound (
    account_id TEXT NOT NULL, effect_key TEXT NOT NULL, conversation_key TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(binding_revision > 0), agent_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','sending','sent','indeterminate','failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), due_at INTEGER NOT NULL DEFAULT 0,
    provider_receipt TEXT, reason_code TEXT, PRIMARY KEY(account_id, effect_key)
  ) STRICT;
  CREATE INDEX channel_outbound_destination ON channel_outbound(account_id,conversation_key,state);
  CREATE TABLE channel_conversations (
    account_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(binding_revision > 0), agent_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(account_id, conversation_key, binding_revision)
  ) STRICT;
`;

type Item = Destination & { eventKey: string; payload: string; started: number | null; attempts: number };
type Claimed = OutboundMessage & { attempts: number };
const destination = ({ accountId, conversationKey, bindingRevision, agentId }: Destination) =>
  [accountId, conversationKey, bindingRevision, agentId] as const;

export class ChannelSpool {
  private readonly spoolDb: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.spoolDb = db;
  }

  transaction<T>(work: () => T): T {
    this.spoolDb.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.spoolDb.exec('COMMIT');
      return value;
    } catch (error) {
      this.spoolDb.exec('ROLLBACK');
      throw error;
    }
  }

  recoverSending() {
    this.spoolDb.exec(`UPDATE channel_outbound SET state='indeterminate',reason_code='interrupted-send'
      WHERE state='sending'`);
  }

  checkpoint(accountId: string) {
    return String(this.spoolDb.prepare('SELECT checkpoint FROM channel_cursors WHERE account_id=?').get(accountId)?.checkpoint ?? '');
  }

  admitBatch(binding: Binding, events: readonly InboundEnvelope[], nextCheckpoint: string, now: number,
    expectedCheckpoint: string) {
    return this.transaction(() => {
      if (this.checkpoint(binding.accountId) !== expectedCheckpoint) return false;
      const insert = this.spoolDb.prepare(`INSERT INTO channel_inbound
        (account_id,conversation_key,binding_revision,agent_id,event_key,received_at,status,payload,reason_code,lane)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,event_key) DO NOTHING`);
      for (const event of events) {
        insert.run(...destination({ ...binding, conversationKey: event.conversationKey }), event.eventKey, event.receivedAt,
          event.reasonCode ? 'rejected' : 'pending', event.payload === undefined ? null : JSON.stringify(event.payload),
          event.reasonCode ?? null, event.lane);
      }
      this.spoolDb.prepare(`INSERT INTO channel_cursors VALUES (?,?,?) ON CONFLICT(account_id)
        DO UPDATE SET checkpoint=excluded.checkpoint,updated_at=excluded.updated_at`).run(binding.accountId, nextCheckpoint, now);
      return true;
    });
  }

  nextInbound(binding: Binding, lane: Lane, now: number) {
    return this.spoolDb.prepare(`SELECT account_id AS accountId, event_key AS eventKey, conversation_key AS conversationKey,
      binding_revision AS bindingRevision, agent_id AS agentId, payload, first_attempt_at AS started, attempts
      FROM channel_inbound AS item
      WHERE account_id=? AND agent_id=? AND binding_revision=? AND lane=? AND status='pending' AND due_at<=? AND NOT EXISTS (
        SELECT 1 FROM channel_inbound AS prior WHERE prior.account_id=item.account_id
          AND prior.conversation_key=item.conversation_key AND prior.binding_revision=item.binding_revision
          AND prior.lane=item.lane AND prior.status IN ('pending','handed_off') AND prior.rowid<item.rowid)
      ORDER BY rowid LIMIT 1`).get(binding.accountId, binding.agentId, binding.bindingRevision, lane, now) as Item | undefined;
  }

  attemptInbound(item: Pick<Item, 'accountId' | 'eventKey'>, now: number, due: number) {
    this.spoolDb.prepare(`UPDATE channel_inbound SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),due_at=?
      WHERE account_id=? AND event_key=? AND status='pending'`).run(now, due, item.accountId, item.eventKey);
  }

  enqueueOutbound(message: OutboundMessage) {
    this.spoolDb.prepare(`INSERT INTO channel_outbound
      (account_id,conversation_key,binding_revision,agent_id,effect_key,payload)
      VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,effect_key) DO NOTHING`)
      .run(...destination(message), message.effectKey, JSON.stringify({ text: message.text, locale: message.locale }));
  }

  completeInbound(eventKey: string, message: OutboundMessage, failed: boolean) {
    this.transaction(() => {
      const { changes } = this.spoolDb.prepare(`UPDATE channel_inbound SET status=?,reason_code=?
        WHERE account_id=? AND conversation_key=? AND binding_revision=? AND agent_id=? AND event_key=? AND status='pending'`)
        .run(failed ? 'failed' : 'handled', failed ? 'intake-deadline' : null, ...destination(message), eventKey);
      if (changes) this.enqueueOutbound(message);
    });
  }

  claimOutbound(binding: Binding, now: number): Claimed | undefined {
    const row = this.spoolDb.prepare(`UPDATE channel_outbound SET state='sending', attempts=attempts+1 WHERE rowid=(
      SELECT item.rowid FROM channel_outbound AS item
      WHERE item.account_id=? AND item.binding_revision=? AND item.agent_id=? AND item.state='pending' AND item.due_at<=?
        AND NOT EXISTS (SELECT 1 FROM channel_outbound AS throttle WHERE throttle.account_id=item.account_id
          AND throttle.state='pending' AND throttle.reason_code='rate-limited' AND throttle.due_at>?)
        AND NOT EXISTS (SELECT 1 FROM channel_outbound AS prior WHERE prior.account_id=item.account_id
          AND prior.conversation_key=item.conversation_key AND prior.state IN ('pending','sending')
          AND prior.rowid<item.rowid) ORDER BY item.rowid LIMIT 1)
      RETURNING conversation_key AS conversationKey, effect_key AS effectKey, payload, attempts`)
      .get(binding.accountId, binding.bindingRevision, binding.agentId, now, now);
    if (!row) return;
    const { text, locale } = JSON.parse(String(row.payload)) as Pick<OutboundMessage, 'text' | 'locale'>;
    return { ...binding, conversationKey: String(row.conversationKey), effectKey: String(row.effectKey),
      attempts: Number(row.attempts), text, locale };
  }

  finishOutbound(message: Claimed, outcome: Delivery) {
    this.spoolDb.prepare(`UPDATE channel_outbound SET state=?,due_at=?,provider_receipt=?,reason_code=?
      WHERE account_id=? AND effect_key=? AND state='sending' AND attempts=?`).run(
      outcome.state, outcome.state === 'pending' ? outcome.retryAt : 0,
      outcome.state === 'sent' ? outcome.receipt ?? null : null,
      outcome.state === 'pending' ? 'rate-limited' : 'reasonCode' in outcome ? outcome.reasonCode : null,
      message.accountId, message.effectKey, message.attempts);
  }

  retryOutbound(accountId: string, effectKey: string) {
    if (!this.spoolDb.prepare(`UPDATE channel_outbound SET state='pending',due_at=0,reason_code=NULL
      WHERE account_id=? AND effect_key=? AND state='indeterminate'`).run(accountId, effectKey).changes) {
      throw new Error('Delivery is unavailable for resend');
    }
  }
}
