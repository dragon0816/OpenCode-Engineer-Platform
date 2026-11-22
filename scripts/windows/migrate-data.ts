import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../../apps/adapter/src/runs/ledger.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
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
  const migrations = {
    'runs.sqlite': (path: string) => new Ledger(path).close(),
    'web.sqlite': (path: string) => new WebStore(path).close(),
    'telegram-chat.sqlite': (path: string) => new WebStore(path).close(),
    'knowledge.sqlite': (path: string) => new KnowledgeStore(path).close(),
    'telegram.sqlite': (path: string) => new TelegramInbox(path, false).db.close(),
  };
  const result = Object.fromEntries(['', 'web/'].flatMap((directory) =>
    Object.entries(migrations).flatMap(([name, migrate]) => {
      const key = directory + name;
      const path = join(root, key);
      failurePath = key;
      failureCheck = '遷移前讀取 SQLite 結構及筆數失敗。';
      if (!existsSync(path)) return [];
      const before = describe(path);
      failureCheck = '套用 SQLite 結構遷移失敗。請檢查版本、權限和剩餘空間。';
      migrate(path);
      failureCheck = '遷移後讀取 SQLite 結構及筆數失敗。';
      return [[key, { before, after: describe(path) }]];
    })));
  console.log(JSON.stringify(result));
} catch {
  console.error(`【${diagnosticPath(failurePath)}】新版資料庫遷移失敗。${failureCheck}`);
  process.exitCode = 1;
}
