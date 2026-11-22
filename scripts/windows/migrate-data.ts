import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareBiWorkspace } from '../../apps/adapter/src/runs/agent-ledger.ts';
import { verifyChannelConversations } from '../../apps/adapter/src/telegram/channel-migration.ts';
import { dataMigrations } from './data-migrations.ts';
import { diagnosticPath } from './snapshot-paths.mjs';

function describe(path: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  const counts = Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all().map(({ name }) => [String(name), db.prepare('SELECT count(*) AS total FROM "' +
      String(name).replaceAll('"', '""') + '"').get()?.total]));
  return { userVersion: db.prepare('PRAGMA user_version').get()?.user_version, counts };
}

let failurePath = '.';
let failureCheck = '讀取資料根目錄參數失敗。';
try {
  const root = process.argv[2];
  if (!root) throw new Error('Missing data root');
  const result = Object.fromEntries(['', 'web/'].flatMap((directory) =>
    Object.entries(dataMigrations).flatMap(([name, { migrate }]) => {
      const key = directory + name;
      const path = join(root, key);
      failurePath = key;
      failureCheck = '遷移前讀取 SQLite 結構及筆數失敗。';
      const existing = existsSync(path);
      // The Telegram session ledger needs a central workspace even if the old Web store was absent.
      if (!existing && !(name === 'web.sqlite' && existsSync(join(root, directory, 'telegram-chat.sqlite')))) return [];
      const before = existing ? describe(path) : null;
      failureCheck = '套用 SQLite 結構遷移失敗。請檢查版本、權限和剩餘空間。';
      migrate(path);
      failureCheck = '遷移後讀取 SQLite 結構及筆數失敗。';
      return [[key, { before, after: describe(path) }]];
    })));
  for (const directory of ['', 'web/']) {
    failurePath = directory + 'telegram.sqlite';
    if (!result[failurePath]) continue;
    failureCheck = '通道會話歸屬檢查失敗。';
    using db = new DatabaseSync(join(root, failurePath), { readOnly: true });
    const path = join(root, directory, 'telegram-chat.sqlite');
    using sessions = existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : undefined;
    verifyChannelConversations(db, sessions);
  }
  if (result['web/web.sqlite'] || result['web.sqlite']) {
    failurePath = 'web/agents/bi';
    failureCheck = '建立 BI 受管工作資料夾失敗。';
    prepareBiWorkspace(join(root, 'web'));
  }
  console.log(JSON.stringify(result));
} catch {
  console.error(`【${diagnosticPath(failurePath)}】新版資料庫遷移失敗。${failureCheck}`);
  process.exitCode = 1;
}
