export type SessionOrigin = 'web' | 'channel' | 'delegation' | 'schedule';
export type Permission = { action: string; resource: string; effect: 'allow' | 'deny' };
export const brokerMcpName = 'oep';
export const statusTool = 'oep_status';
export const readFileTool = 'oep_file_read';
export const writeFileTool = 'oep_file_write';
export const knowledgeTool = 'oep_knowledge_ask';
export const biQueryTool = 'oep_bi_query';
export const listSpecialistsTool = 'oep_list_specialists';
export const delegateTool = 'oep_delegate_to_specialist';

type PermissionScope = { origin: SessionOrigin; agentID: string; status?: boolean;
  files?: boolean; knowledge?: boolean; biQuery?: boolean; delegation?: boolean; custom?: readonly string[]; skills?: readonly string[] };

// The separate Phase 1 acceptance runner still exercises the pinned native Workbook template.
export function nativeContractPermissions(workbook: boolean): Permission[] {
  return [...sessionPermissions(),
    { action: 'read', resource: 'sop.md', effect: 'allow' },
    { action: 'read', resource: 'marker.txt', effect: 'allow' },
    ...(workbook ? [{ action: 'edit', resource: 'program.js', effect: 'allow' } as const] : [])];
}

export function sessionPermissions(scope?: PermissionScope): Permission[] {
  const rules: Permission[] = [{ action: '*', resource: '*', effect: 'deny' }];
  if (!scope) return rules;
  const allow = (action: string, resource = '*') => rules.push({ action, resource, effect: 'allow' });
  if (scope.origin !== 'web' && scope.origin !== 'channel' &&
      !(scope.origin === 'delegation' && scope.agentID !== 'main')) return rules;
  if (scope.status) allow(statusTool);
  if (scope.files) {
    allow(readFileTool);
    allow(writeFileTool);
  }
  if (scope.knowledge) allow(knowledgeTool);
  for (const name of scope.skills ?? []) allow('skill', name);
  if (scope.biQuery) allow(biQueryTool);
  if (scope.delegation && scope.agentID === 'main' && (scope.origin === 'web' || scope.origin === 'channel')) {
    allow(listSpecialistsTool);
    allow(delegateTool);
  }
  for (const name of scope.custom ?? []) {
    if (/^oep_custom_[a-f0-9]{32}_[a-z0-9_]{1,120}$/.test(name)) allow(name);
  }
  return rules;
}

export function allowedModelTool(permissions: readonly Permission[], name: string) {
  // OpenCode's write/edit tools both use the edit permission. Keep its exact resource check in OpenCode.
  const action = name === 'write' ? 'edit' : name;
  const rule = permissions.findLast(({ action: pattern }) => pattern === '*' || pattern === action ||
    pattern.endsWith('*') && action.startsWith(pattern.slice(0, -1)));
  return rule?.effect === 'allow';
}

export function retainsPermissions(admitted: readonly Permission[], current: readonly Permission[]) {
  return admitted.every((rule) => rule.effect === 'deny' || current.some((next) => next.effect === 'allow' &&
    next.action === rule.action && next.resource === rule.resource)) &&
    current.every((rule) => rule.effect === 'allow' || rule.action === '*' || !allowedModelTool(admitted, rule.action));
}
