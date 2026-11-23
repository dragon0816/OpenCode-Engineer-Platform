import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider } from '../../../apps/adapter/src/runs/external-ledger.ts';
import { windowsExternalIsolation, windowsHelperOs } from '../../../apps/adapter/src/runs/external-windows.ts';

export function subscriptionHelper(root: string, profile: string) {
  mkdirSync(profile);
  const fake = fileURLToPath(new URL('./fake-subscription.mjs', import.meta.url));
  const os = windowsHelperOs(root, () => spawn(process.execPath, [fake, 'supervisor', profile], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  }));
  return {
    isolation: windowsExternalIsolation(root, os),
    mode: (provider: Provider, value: string) => writeFileSync(join(profile, provider + '.mode'), value),
    approveDevice: () => writeFileSync(join(profile, 'approve-device'), ''),
    syntheticCredential: 'synthetic-subscription-credential-do-not-relay',
    code: 'synthetic-one-time-code#state',
  };
}
