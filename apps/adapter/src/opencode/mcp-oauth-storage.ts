import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebMessageError } from '../http/errors.ts';
import { protectMcpOAuthData } from '../runs/custom-mcp-credentials.ts';
import { checkDirectory } from '../runs/workspace.ts';

export const mcpOAuthFolder = 'mcp-oauth';

export function mcpOAuthStorage(root: string) {
  const folder = join(root, mcpOAuthFolder);
  const file = (id: string) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new WebMessageError('mcp-invalid-server-id');
    return join(folder, `${id}.dpapi`);
  };
  return {
    read(id: string): unknown {
      const path = file(id);
      if (!lstatSync(folder, { throwIfNoEntry: false })) return;
      checkDirectory(folder);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) return;
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new WebMessageError('credential-access');
      const encoded = protectMcpOAuthData('Unprotect', readFileSync(path, 'ascii'));
      try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
      catch { throw new WebMessageError('credential-access'); }
    },
    write(id: string, value?: object) {
      const path = file(id);
      if (value) mkdirSync(folder, { recursive: true });
      if (!lstatSync(folder, { throwIfNoEntry: false })) return;
      checkDirectory(folder);
      if (!value) { rmSync(path, { force: true }); return; }
      const encoded = protectMcpOAuthData('Protect', Buffer.from(JSON.stringify(value)).toString('base64'));
      const temp = join(folder, `${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, encoded, { flag: 'wx' });
        renameSync(temp, path);
      } finally { rmSync(temp, { force: true }); }
    },
  };
}
