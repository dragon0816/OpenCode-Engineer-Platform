import { startLoopbackMcp } from './loopback-mcp.ts';
import { statusTool } from './permissions.ts';
import { stripTransport, transportField } from './tool-transport.ts';
import type { ToolTickets } from './tool-tickets.ts';

export const statusMcpName = 'oep';
const toolName = 'status';

export function startStatusMcp(tickets: ToolTickets) {
  return startLoopbackMcp({ name: statusMcpName, timeout: 5_000,
    invalidArguments: 'Tool authorization unavailable', failed: 'Tool authorization unavailable',
    tools: [{ name: toolName, description: 'Return the current agent and workspace display names.',
      inputSchema: { type: 'object', properties: { [transportField]: { type: 'string' } },
        required: [transportField], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }],
    invoke(name, args, signal) {
      if (name !== toolName || signal.aborted) return;
      const result = stripTransport(tickets.consume(statusTool, args));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  });
}
