import { customMcpName } from '../runs/custom-mcp.ts';
import type { CustomMcp } from '../runs/custom-mcp.ts';
import { workbookInput } from '../runs/web-workbook.ts';
import { knowledgeMcpName, knowledgeToolName } from './knowledge-mcp.ts';

export type SessionOrigin = 'web' | 'channel' | 'delegation' | 'schedule';
export type Permission = { action: string; resource: string; effect: 'allow' | 'deny' };
export const statusTool = 'oep_status';
export const knowledgeTool = `${knowledgeMcpName}_${knowledgeToolName}`;

type Access = { knowledge?: boolean; status?: boolean; custom?: readonly Pick<CustomMcp, 'id' | 'deniedTools'>[] };
type PermissionScope =
  | { origin: 'synthetic'; workbook?: boolean }
  | ({ origin: SessionOrigin; agentID: string; workbookRun?: string } & Access);

export function sessionPermissions(scope: PermissionScope): Permission[] {
  const rules: Permission[] = [{ action: '*', resource: '*', effect: 'deny' }];
  const allow = (action: string, resource = '*') => rules.push({ action, resource, effect: 'allow' });
  if (scope.origin === 'synthetic') {
    allow('read', 'sop.md');
    allow('read', 'marker.txt');
    if (scope.workbook) allow('edit', 'program.js');
    return rules;
  }
  if (scope.origin !== 'web' && scope.origin !== 'channel') return rules;
  if (scope.status) allow(statusTool);
  if (scope.agentID !== 'main') return rules;
  if (scope.knowledge) allow(knowledgeTool);
  for (const server of scope.custom ?? []) {
    const name = customMcpName(server.id);
    allow(`${name}_*`);
    for (const tool of server.deniedTools) rules.push({ action: `${name}_${tool}`, resource: '*', effect: 'deny' });
  }
  // Transitional until slice 2b replaces Workbook's native write with a brokered file tool.
  if (scope.origin === 'web' && scope.workbookRun) allow('edit', workbookInput(scope.workbookRun));
  return rules;
}

export function allowedModelTool(permissions: readonly Permission[], name: string) {
  // OpenCode's write/edit tools both use the edit permission. Keep its exact resource check in OpenCode.
  const action = name === 'write' ? 'edit' : name;
  const rule = permissions.findLast(({ action: pattern }) => pattern === '*' || pattern === action ||
    pattern.endsWith('*') && action.startsWith(pattern.slice(0, -1)));
  return rule?.effect === 'allow';
}
