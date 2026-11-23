import { uuid } from '../runs/attachments.ts';
import { delegateTool, listSpecialistsTool } from './permissions.ts';
import { externalProvider } from '../runs/external-ledger.ts';

export type DelegationInput = { specialistId: string; task: string; requestKey: string; attachmentIds?: string[] };
export type ExternalDelegationInput = { specialistId: string; publicInputId: string; requestKey: string };

const agentPattern = '^[a-z0-9][a-z0-9_-]{0,79}$';
const agentId = new RegExp(agentPattern);
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.isWellFormed() && value.length > 0 && [...value].length <= max;

export function delegationArgs(args: Record<string, unknown>): args is DelegationInput {
  return Object.keys(args).every((key) => ['specialistId', 'task', 'requestKey', 'attachmentIds'].includes(key)) &&
    typeof args.specialistId === 'string' && agentId.test(args.specialistId) &&
    bounded(args.task, 4000) && bounded(args.requestKey, 64) &&
    (!Object.hasOwn(args, 'attachmentIds') || Array.isArray(args.attachmentIds) &&
      args.attachmentIds.length <= 4 && new Set(args.attachmentIds).size === args.attachmentIds.length &&
      args.attachmentIds.every((id) => typeof id === 'string' && uuid.test(id)));
}

export function externalDelegationArgs(args: Record<string, unknown>): args is ExternalDelegationInput {
  return Object.keys(args).length === 3 && Boolean(externalProvider(args.specialistId)) &&
    typeof args.publicInputId === 'string' && uuid.test(args.publicInputId) && bounded(args.requestKey, 64);
}

export const delegationTools = [{
  name: listSpecialistsTool,
  description: 'List OEP specialists and their availability for work requested by the user.',
  properties: {},
  required: [],
  validate: (args: Record<string, unknown>) => Object.keys(args).length === 0,
  readOnly: true,
}, {
  name: delegateTool,
  description: 'Queue a specialist task. For an external-source specialist, use the user’s exact task words and attachment IDs from this message. Reuse the key when retrying.',
  properties: {
    specialistId: { type: 'string', pattern: agentPattern },
    task: { type: 'string', minLength: 1, maxLength: 4000 },
    attachmentIds: { type: 'array', maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: uuid.source } },
    requestKey: { type: 'string', minLength: 1, maxLength: 64 },
    publicInputId: { type: 'string', pattern: uuid.source },
  },
  required: ['specialistId', 'requestKey'],
  oneOf: [
    { required: ['task'], not: { required: ['publicInputId'] } },
    { required: ['publicInputId'], not: { anyOf: [{ required: ['task'] }, { required: ['attachmentIds'] }] } },
  ],
  validate: (args: Record<string, unknown>) => externalDelegationArgs(args) || delegationArgs(args),
  readOnly: false,
}];
