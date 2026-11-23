import { digestPattern, identifier, sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import { uuid } from '../runs/attachments.ts';
import { DelegationError, type Classification } from '../runs/delegation-ledger.ts';
import { helpers, isProvider, type SourceSubmission } from '../runs/external-ledger.ts';
import { HttpError } from './errors.ts';
import type { WebMessageCode } from './messages.ts';
import type { HelperAuthAction } from '../runs/external-cli.ts';

const namedGate = new Set(['external-confidential', 'external-unclassified', 'external-changed']);
export const externalError = (error: DelegationError) => {
  const named = error.item && namedGate.has(error.code);
  return new HttpError(error.code === 'external-invalid-input' ? 400 : 409,
    (named ? error.code + '-item' : error.code) as WebMessageCode, named ? { name: error.item! } : undefined);
};
export const invalidExternal = () => new HttpError(400, 'external-invalid-input');
export const labelInput = (value: unknown): value is Classification => value === 'unclassified' || value === 'public' || value === 'confidential';
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export const hashInput = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value);
export const identifiers = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);
const ids = (value: unknown, min: number, max: number): value is string[] => Array.isArray(value) &&
  value.length >= min && value.length <= max && new Set(value).size === value.length && value.every(id);

export function helperSettings(input: Record<string, unknown>) {
  const { provider, enabled, confirmEachRun, termsConfirmed, revision, warningAccepted, ...extra } = input;
  if (Object.keys(extra).length || !isProvider(provider) || typeof enabled !== 'boolean' || typeof confirmEachRun !== 'boolean' ||
      typeof termsConfirmed !== 'boolean' || provider === 'codex_cli' && termsConfirmed || typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) || revision < 1 || warningAccepted !== undefined && warningAccepted !== true) throw invalidExternal();
  return { settings: { provider, enabled, confirmEachRun, termsConfirmed, revision }, warningAccepted };
}

export function helperAuth(input: Record<string, unknown>) {
  const { provider, action, key, ...extra } = input;
  if (!isProvider(provider) || Object.keys(extra).length) throw invalidExternal();
  let request: HelperAuthAction;
  if (action === 'key' && typeof key === 'string' && /^[\x21-\x7e]{8,1024}$/.test(key)) request = { action, key };
  else if ((action === 'cli' || action === 'logout') && key === undefined) request = { action };
  else throw invalidExternal();
  return { provider, request };
}

export function externalWorkspaceInput(input: Record<string, unknown>) {
  const { workspaceId, classification, ...extra } = input;
  if (typeof workspaceId !== 'string' || !/^[a-z\d_-]{1,80}$/.test(workspaceId) ||
      !labelInput(classification) || Object.keys(extra).length) throw invalidExternal();
  return { workspaceId, classification };
}

export function sourceInput(input: Record<string, unknown>): SourceSubmission {
  if (input.kind === 'workspace') {
    const { kind, folder, path, ...extra } = input;
    if (hashInput(folder) && typeof path === 'string' && path.length <= 1024 && !Object.keys(extra).length) return { kind, folder, path };
  } else if (input.kind === 'citation') {
    const { kind, vault, revision, passage, sha256, ...extra } = input;
    if (identifiers(vault) && identifiers(revision) && identifiers(passage) && hashInput(sha256) &&
        !Object.keys(extra).length) return { kind, vault, revision, passage, sha256 };
  } else if ((input.kind === 'owner_text' || input.kind === 'derived') && typeof input.text === 'string' &&
      input.text.trim() && input.text.isWellFormed() && input.text.length <= 16_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)) {
    const { kind, text, ...extra } = input;
    if (kind === 'owner_text' && extra.ownerAuthored === true && Object.keys(extra).length === 1) return { kind, text };
    if (kind === 'derived' && ids(extra.sources, 1, 4) && Object.keys(extra).length === 1) return { kind, text, sources: extra.sources };
  }
  throw invalidExternal();
}

export function snapshotInput(input: Record<string, unknown>) {
  const { runId, provider, taskId, inputs, ...extra } = input;
  if (!id(runId) || !isProvider(provider) || !id(taskId) || !ids(inputs, 0, 4) || inputs.includes(taskId) ||
      Object.keys(extra).length) throw invalidExternal();
  return { runId, provider, taskId, inputs, specialistId: helpers[provider].id };
}

export const folderChoices = (folders: string[]) => folders.map((path) => ({ id: sha256(path), path }));
