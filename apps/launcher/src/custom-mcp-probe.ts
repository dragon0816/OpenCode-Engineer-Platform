import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { until } from '../../../scripts/phase0/probe-http.ts';
import type { CustomMcp } from '../../adapter/src/runs/custom-mcp.ts';
import type { CredentialEnvironment } from '../../adapter/src/runs/custom-mcp-credentials.ts';
import { startJob } from './job-object.ts';

const reasons = {
  missing: '找不到指定的執行檔。',
  exited: '伺服器在完成連線前結束，或傳回無效的資料。',
  timeout: '伺服器握手或工具清單讀取逾時。',
  auth: '需要憑證，請檢查憑證是否已設定且有效。',
  tls: '無法驗證 TLS 憑證或建立安全連線。',
  url: '網址遭拒絕。請檢查位址與重新導向設定。',
};

type Catalog = { tools: { name: string; description: string }[] } | { reason: keyof typeof reasons };

export async function testCustomMcp(server: CustomMcp, readCredentials?: CredentialEnvironment['readCredentials']) {
  const control = mkdtempSync(join(tmpdir(), 'oep-mcp-probe-'));
  try {
    const workspace = join(control, 'workspace');
    mkdirSync(workspace);
    const resultPath = join(control, 'result.json');
    const definition = server.transport === 'stdio' ? { ...server, cwd: workspace } : server;
    writeFileSync(join(control, 'definition.json'), JSON.stringify(definition), { flag: 'wx' });
    const names = server.environment.map(({ reference }) => reference);
    const injected = readCredentials?.(names);
    writeFileSync(join(control, 'mcp-credential-names.json'), JSON.stringify(injected ? [] : names), { flag: 'wx' });
    const system = process.env.SystemRoot!;
    const job = startJob(control, workspace, {
      SystemRoot: system, WINDIR: system, SystemDrive: process.env.SystemDrive, COMSPEC: join(system, 'System32', 'cmd.exe'),
      PATH: [dirname(process.execPath), join(system, 'System32'), system].join(delimiter),
      HOME: control, USERPROFILE: control, APPDATA: control, LOCALAPPDATA: control, TEMP: control, TMP: control,
      OEP_JOB_MCP_PROBE: '1', OEP_JOB_TEST_SCOPE: randomBytes(16).toString('hex'),
      ...(injected && Object.fromEntries(names.map((name) => [name, injected[name]]))),
    });
    let catalog: Catalog;
    let clean = false;
    try {
      // A fast probe can publish its result before the supervisor checks Job membership.
      await job.ready();
      catalog = await until(async () => {
        if (!job.alive()) return { reason: 'exited' };
        if (existsSync(resultPath)) return JSON.parse(readFileSync(resultPath, 'utf8')) as Catalog;
      });
    } catch { catalog = { reason: 'timeout' }; }
    finally {
      const cleanup = await job.stop();
      clean = cleanup.supervisorExit === 0 && cleanup.orphans === 0;
    }
    if (!clean) return { ok: false as const, reason: '無法確認測試程序已結束。' };
    return 'reason' in catalog ? { ok: false as const, reason: reasons[catalog.reason] }
      : { ok: true as const, tools: catalog.tools };
  } finally {
    rmSync(control, { recursive: true, force: true });
  }
}
