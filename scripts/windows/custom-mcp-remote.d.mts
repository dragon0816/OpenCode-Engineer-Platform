import type { CustomRemoteMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';

export function sendRemoteMcp(server: CustomRemoteMcp, message: { jsonrpc: '2.0'; id?: number; method: string; params?: unknown },
  session: { id?: string; version?: string }, headers: Record<string, string>, signal: AbortSignal):
  Promise<{ result?: unknown; error?: unknown } | undefined>;
