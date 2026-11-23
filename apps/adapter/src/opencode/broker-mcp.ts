import { startLoopbackMcp } from './loopback-mcp.ts';
import { brokerMcpName, knowledgeTool, readFileTool, statusTool, writeFileTool } from './permissions.ts';
import { stripTransport, transportField } from './tool-transport.ts';
import type { ToolTickets } from './tool-tickets.ts';
import { fileReadArgs, fileWriteArgs, fileWriteLimit } from '../runs/controlled-files.ts';
import { referenceReadSchema } from '../runs/local-references.ts';
import { parseAsk } from '../../../../packages/knowledge/src/ask.ts';
import { objectRecord } from './tool-transport.ts';
import { withMcpTicket } from './remote-mcp-broker.ts';
import type { RemoteMcpBroker } from './remote-mcp-broker.ts';
import { delegationTools } from './delegation-tools.ts';

const localName = (name: string) => name.slice(brokerMcpName.length + 1);
const ticket = { [transportField]: { type: 'string' } };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties: { ...properties, ...ticket }, required: [...required, transportField], additionalProperties: false,
});
const readOnly = { readOnlyHint: true, destructiveHint: false };

export function startBrokerMcp(tickets: ToolTickets, remote: RemoteMcpBroker) {
  tickets.register(readFileTool, fileReadArgs);
  tickets.register(writeFileTool, fileWriteArgs);
  tickets.register(knowledgeTool, (args) => Boolean(parseAsk(args)));
  for (const { name, validate } of delegationTools) tickets.register(name, validate);
  for (const { name, validate } of remote.tools) tickets.register(name, validate);
  return startLoopbackMcp({ name: brokerMcpName, timeout: remote.timeout, maxInput: 448 * 1024,
    invalidArguments: 'Tool authorization unavailable', failed: 'Tool authorization unavailable',
    tools: [{ name: localName(statusTool), description: 'Return the current agent and workspace display names.',
      inputSchema: schema({}), annotations: readOnly,
    }, {
      name: localName(readFileTool),
      description: 'Read a session attachment ID, artifact ID, or current output name. For a selected local reference, pass reference and optional byte offset and length. Folder references accept list:true with optional relative path and after cursor, or a relative file path to read. For PDF extraction use page (1-based); next is the next byte offset within the text or page.',
      inputSchema: schema({ attachment: { type: 'string' }, artifact: { type: 'string' }, name: { type: 'string' }, ...referenceReadSchema }),
      annotations: readOnly,
    }, {
      name: localName(writeFileTool), description: 'Create a new UTF-8 file in the current run output.',
      inputSchema: schema({ name: { type: 'string', maxLength: 96 }, content: { type: 'string', maxLength: fileWriteLimit } },
        ['name', 'content']),
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, {
      name: localName(knowledgeTool), description: 'Ask an authorized published OEP knowledge vault by ID. Report verified excerpts and citations, or relay the abstention.',
      inputSchema: schema({ vault: { type: 'string' }, question: { type: 'string', maxLength: 500 } }, ['vault', 'question']),
      annotations: readOnly,
    }, ...delegationTools.map(({ name, description, properties, required, readOnly, oneOf }) => ({
      name: localName(name), description, inputSchema: { ...schema(properties, required), ...(oneOf && { oneOf }) },
      annotations: { readOnlyHint: readOnly, destructiveHint: false },
    })), ...remote.tools.map(({ name, description, inputSchema }) => ({
      name: localName(name), description, inputSchema: withMcpTicket(inputSchema),
    }))],
    async invoke(name, args, signal) {
      if (typeof name !== 'string' || signal.aborted) return;
      const tool = `${brokerMcpName}_${name}`;
      const grant = tickets.consume(tool, args);
      const active = AbortSignal.any([signal, grant.signal]);
      active.throwIfAborted();
      const result = tool === statusTool ? { agent: grant.scope.name || 'OEP', workspace: grant.scope.workspaceName }
        : await grant.invoke?.(tool, grant.args, active) ?? await remote.invoke(tool, grant.args, active);
      active.throwIfAborted();
      grant.assertCurrent();
      if (result !== undefined) return { content: [{ type: 'text', text: JSON.stringify(stripTransport(result)) }],
        ...((objectRecord(result)?.state === 'error' || objectRecord(result)?.isError === true) && { isError: true }) };
    },
  });
}
