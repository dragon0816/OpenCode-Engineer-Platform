import { allowedModelTool } from './permissions.ts';
import type { Permission } from './permissions.ts';
import { containsTransport, nonceMarker, objectRecord, transportField } from './tool-transport.ts';

export type RelayScope = { nonce: string; model: string; permissions: readonly Permission[]; live: () => boolean;
  brokered?: (name: string) => boolean;
  issue?: (tool: string, callID: string, args: unknown) => string };

export function matchesNonce(content: unknown, nonce: string): boolean {
  if (typeof content === 'string') return content.endsWith(nonceMarker(nonce));
  return Array.isArray(content) && content.some((part) => objectRecord(part)?.type === 'text' && matchesNonce(part.text, nonce));
}

export function allowedToolDefinitions(input: unknown, scope: RelayScope) {
  const names = new Set<string>();
  if (input === undefined) return { tools: undefined, names };
  if (!Array.isArray(input)) throw new Error('Invalid tool definitions');
  const tools = input.filter((item) => {
    const definition = objectRecord(objectRecord(item)?.function);
    const name = definition?.name;
    if (typeof name !== 'string' || !allowedModelTool(scope.permissions, name)) return false;
    if (scope.brokered?.(name)) {
      const schema = objectRecord(definition?.parameters);
      if (!scope.issue || !schema || !Object.hasOwn(objectRecord(schema.properties) ?? {}, transportField) ||
          !Array.isArray(schema.required) || !schema.required.includes(transportField)) throw new Error('Invalid broker tool schema');
    }
    names.add(name);
    return true;
  });
  return { tools, names };
}

type Call = { name?: string; id?: string; pieces: Record<string, unknown>[] };

export function authorizeToolCalls(frames: Record<string, unknown>[], allowed: Set<string>, scope: RelayScope) {
  const calls = new Map<string, Call>();
  for (const frame of frames) {
    if (!Array.isArray(frame.choices)) throw new Error('Invalid tool completion');
    for (const choice of frame.choices) {
      const delta = objectRecord(choice.delta);
      if (choice.message !== undefined || delta?.function_call !== undefined) throw new Error('Invalid tool completion');
      const chunks = delta?.tool_calls;
      if (chunks === undefined) continue;
      if (!Array.isArray(chunks)) throw new Error('Invalid tool completion');
      for (const item of chunks) {
        const chunk = objectRecord(item);
        const fn = objectRecord(chunk?.function);
        if (!chunk || !fn || !Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 ||
            chunk.type !== undefined && chunk.type !== 'function') throw new Error('Invalid tool completion');
        const key = `${choice.index}:${chunk.index}`;
        const call = calls.get(key) ?? { pieces: [] };
        if (chunk.id !== undefined || fn.name !== undefined) {
          if (call.pieces.length || typeof chunk.id !== 'string' || !chunk.id || typeof fn.name !== 'string') {
            throw new Error('Invalid tool call identity');
          }
          call.id = chunk.id;
          call.name = fn.name;
        }
        if (fn.arguments !== undefined && typeof fn.arguments !== 'string') throw new Error('Invalid tool arguments');
        call.pieces.push(fn);
        calls.set(key, call);
      }
    }
  }
  const ids = new Set<string>();
  const brokerCalls: { call: Call; args: Record<string, unknown>; id: string }[] = [];
  for (const call of calls.values()) {
    if (!call.id || !call.name || ids.has(call.id) || !allowed.has(call.name)) throw new Error('Tool not authorized');
    ids.add(call.id);
    const args = objectRecord(JSON.parse(call.pieces.map((part) => part.arguments ?? '').join('')));
    if (!args || containsTransport(args)) throw new Error('Invalid tool arguments');
    if (call.name === 'skill' && (typeof args.id !== 'string' || Object.keys(args).length !== 1 ||
      !scope.permissions.some(({ action, resource, effect }) => action === 'skill' && resource === args.id && effect === 'allow'))) {
      throw new Error('Skill not authorized');
    }
    if (scope.brokered?.(call.name)) {
      if (!scope.issue) throw new Error('Invalid broker tool arguments');
      brokerCalls.push({ call, args, id: call.id });
    }
  }
  for (const { call, args, id } of brokerCalls) {
    call.pieces[0].arguments = JSON.stringify({ ...args, [transportField]: scope.issue!(call.name!, id, args) });
    for (const piece of call.pieces.slice(1)) piece.arguments = '';
  }
}
