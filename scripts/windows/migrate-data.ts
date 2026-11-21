import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';

function describe(path: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  const counts = Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all().map(({ name }) => [String(name), db.prepare('SELECT count(*) AS total FROM "' +
      String(name).replaceAll('"', '""') + '"').get()?.total]));
  return { userVersion: db.prepare('PRAGMA user_version').get()?.user_version, counts };
}

try {
  const root = process.argv[2];
  if (!root) throw new Error('Missing data root');
  const migrations = {
    'web.sqlite': (path: string) => new WebStore(path).close(),
    'telegram-chat.sqlite': (path: string) => new WebStore(path).close(),
    'knowledge.sqlite': (path: string) => new KnowledgeStore(path).close(),
    'telegram.sqlite': (path: string) => new TelegramInbox(path, false).db.close(),
  };
  const result = Object.fromEntries(Object.entries(migrations).flatMap(([name, migrate]) => {
    const path = join(root, name);
    if (!existsSync(path)) return [];
    const before = describe(path);
    migrate(path);
    return [[name, { before, after: describe(path) }]];
  }));
  console.log(JSON.stringify(result));
} catch {
  console.error('資料庫遷移失敗。請檢查資料庫版本、權限和剩餘空間。');
  process.exitCode = 1;
}
