import { parseAsk } from '../../../../packages/knowledge/src/ask.ts';
import type { KnowledgeAsk } from '../../../../packages/knowledge/src/ask.ts';
import { startLoopbackMcp } from './loopback-mcp.ts';

export const knowledgeMcpName = 'oep_knowledge';
export const knowledgeToolName = 'ask';

export function startKnowledgeMcp(ask: Pick<KnowledgeAsk, 'ask'>) {
  return startLoopbackMcp({ name: knowledgeMcpName, timeout: 80_000,
    invalidArguments: 'Select a vault and enter an engineering question', failed: 'Knowledge request could not be completed',
    tools: [{ name: knowledgeToolName,
      description: 'Ask a specific published OEP knowledge vault. Use the vault ID shown on the Knowledge page. Report the verified excerpts and citations, or relay the abstention.',
      inputSchema: { type: 'object', properties: { vault: { type: 'string' }, question: { type: 'string', maxLength: 500 } },
        required: ['vault', 'question'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }],
    async invoke(name, args, signal) {
      const input = parseAsk(args);
      if (name !== knowledgeToolName || !input) return;
      const result = await ask.ask(input, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.state === 'error' };
    },
  });
}
