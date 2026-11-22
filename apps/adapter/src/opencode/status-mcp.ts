import { startLoopbackMcp } from './loopback-mcp.ts';
import { brokerMcpName, readFileTool, statusTool, writeFileTool } from './permissions.ts';
import { stripTransport, transportField } from './tool-transport.ts';
import type { ToolTickets } from './tool-tickets.ts';
import { fileReadArgs, fileWriteArgs, fileWriteLimit } from '../runs/controlled-files.ts';

const localName = (name: string) => name.slice(brokerMcpName.length + 1);
const ticket = { [transportField]: { type: 'string' } };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties: { ...properties, ...ticket }, required: [...required, transportField], additionalProperties: false,
});
const readOnly = { readOnlyHint: true, destructiveHint: false };

export function startBrokerMcp(tickets: ToolTickets) {
  tickets.register(readFileTool, fileReadArgs);
  tickets.register(writeFileTool, fileWriteArgs);
  return startLoopbackMcp({ name: brokerMcpName, timeout: 10_000, maxInput: 448 * 1024,
    invalidArguments: 'Tool authorization unavailable', failed: 'Tool authorization unavailable',
    tools: [{ name: localName(statusTool), description: 'Return the current agent and workspace display names.',
      inputSchema: schema({}), annotations: readOnly,
    }, {
      name: localName(readFileTool),
      description: 'Read one file by session attachment ID, session artifact ID, or exact file name from the current run output.',
      inputSchema: schema({ attachment: { type: 'string' }, artifact: { type: 'string' }, name: { type: 'string' } }),
      annotations: readOnly,
    }, {
      name: localName(writeFileTool), description: 'Create a new UTF-8 file in the current run output.',
      inputSchema: schema({ name: { type: 'string', maxLength: 96 }, content: { type: 'string', maxLength: fileWriteLimit } },
        ['name', 'content']),
      annotations: { readOnlyHint: false, destructiveHint: false },
    }],
    async invoke(name, args, signal) {
      if (typeof name !== 'string' || signal.aborted) return;
      const tool = `${brokerMcpName}_${name}`;
      const grant = tickets.consume(tool, args);
      const active = AbortSignal.any([signal, grant.signal]);
      active.throwIfAborted();
      const result = tool === statusTool ? { agent: grant.scope.name || 'OEP', workspace: grant.scope.workspaceName }
        : await grant.invoke?.(tool, grant.args, active);
      active.throwIfAborted();
      grant.assertCurrent();
      if (result !== undefined) return { content: [{ type: 'text', text: JSON.stringify(stripTransport(result)) }] };
    },
  });
}
