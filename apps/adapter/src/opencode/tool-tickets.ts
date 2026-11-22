import { createHash, randomBytes } from 'node:crypto';
import { allowedModelTool, statusTool } from './permissions.ts';
import type { Permission } from './permissions.ts';
import { objectRecord, ticketPattern, transportField } from './tool-transport.ts';

type Scope = { agentID: string; workspaceID: string; origin: string; revision: number; model: string;
  name: string; workspaceName: string; permissions: readonly Permission[] };
type Status = { agent: string; workspace: string };
type Identity = { sessionID: string; runID: string; scope: Scope };
type Ticket = { launch: string; sessionID: string; runID: string; tool: string; callID: string; argsHash: string; expires: number };
type Active = { identity: Identity; signal: AbortSignal; current: () => Scope | undefined; fingerprint: string;
  onAbort: () => void; calls: Set<string>; tickets: Map<string, Ticket> };

function normalizedStatusArgs(args: unknown) {
  const object = objectRecord(args);
  // Status has a closed, empty argument schema. This also rejects every caller-supplied scope or credential field.
  if (!object || Object.keys(object).length) throw new Error('Invalid tool arguments');
  return createHash('sha256').update(JSON.stringify(object)).digest('hex');
}

export class ToolTickets {
  private readonly launch = randomBytes(32).toString('hex');
  private active?: Active;
  private closed = false;
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(now = () => performance.now(), ttl = 15_000) {
    this.now = now;
    this.ttl = ttl;
  }

  private current(attempt: Active) {
    if (this.active !== attempt || attempt.signal.aborted) throw new Error('Tool authorization unavailable');
    let scope: Scope | undefined;
    try { scope = attempt.current(); }
    catch { /* Scope resolution failure invalidates the attempt. */ }
    if (!scope || JSON.stringify(scope) !== attempt.fingerprint) {
      this.revoke();
      throw new Error('Tool authorization changed');
    }
    return scope;
  }

  begin(identity: Identity, signal: AbortSignal, current: () => Scope | undefined) {
    if (this.closed || this.active || signal.aborted) throw new Error('Tool authorization unavailable');
    const close = () => {
      if (this.active === attempt) this.revoke();
    };
    const attempt: Active = { identity, signal, current, onAbort: close, fingerprint: JSON.stringify(identity.scope),
      calls: new Set(), tickets: new Map() };
    this.active = attempt;
    signal.addEventListener('abort', close, { once: true });
    return {
      nonce: randomBytes(32).toString('hex'), close,
      issue: (tool: string, callID: string, args: unknown) => {
        const scope = this.current(attempt);
        if (tool !== statusTool || !allowedModelTool(scope.permissions, tool) || !callID || attempt.calls.has(callID)) {
          throw new Error('Tool call unavailable');
        }
        const argsHash = normalizedStatusArgs(args);
        const token = `oep-ticket-${randomBytes(32).toString('hex')}`;
        const { sessionID, runID } = attempt.identity;
        attempt.calls.add(callID);
        attempt.tickets.set(token, { launch: this.launch, sessionID, runID, tool, callID, argsHash, expires: this.now() + this.ttl });
        return token;
      },
    };
  }

  consume(tool: string, input: unknown): Status {
    const attempt = this.active;
    const args = objectRecord(input);
    const token = args?.[transportField];
    if (!attempt || !args || typeof token !== 'string' || !ticketPattern.test(token)) throw new Error('Invalid tool ticket');
    const ticket = attempt.tickets.get(token);
    const { sessionID, runID } = attempt.identity;
    if (!ticket || ticket.launch !== this.launch || ticket.sessionID !== sessionID || ticket.runID !== runID ||
        ticket.tool !== tool || !attempt.calls.has(ticket.callID)) throw new Error('Invalid tool ticket');
    if (ticket.expires <= this.now()) {
      attempt.tickets.delete(token);
      throw new Error('Tool ticket expired');
    }
    const scope = this.current(attempt);
    if (!allowedModelTool(scope.permissions, tool)) throw new Error('Tool authorization unavailable');
    const { [transportField]: _token, ...params } = args;
    if (ticket.argsHash !== normalizedStatusArgs(params)) throw new Error('Invalid tool arguments');
    attempt.tickets.delete(token);
    return { agent: scope.name || 'OEP', workspace: scope.workspaceName };
  }

  private revoke() {
    this.active?.signal.removeEventListener('abort', this.active.onAbort);
    this.active?.tickets.clear();
    this.active = undefined;
  }

  close() {
    this.closed = true;
    this.revoke();
  }
}
