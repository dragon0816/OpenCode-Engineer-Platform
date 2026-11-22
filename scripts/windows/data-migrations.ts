import { Ledger, runLedgerVersion, telegramChatLedgerVersion, webLedgerVersion } from '../../apps/adapter/src/runs/ledger.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { TelegramInbox, telegramInboxVersion } from '../../apps/adapter/src/telegram/inbox.ts';
import { KnowledgeStore, knowledgeSchemaVersion } from '../../packages/knowledge/src/store.ts';

const migrateWebStore = (path: string) => new WebStore(path).close();

// The candidate's stores supply the expected versions independently of the live migration result.
export const dataMigrations = {
  'runs.sqlite': { version: runLedgerVersion, migrate: (path: string) => new Ledger(path).close() },
  'web.sqlite': { version: webLedgerVersion, migrate: migrateWebStore },
  'telegram-chat.sqlite': { version: telegramChatLedgerVersion, migrate: migrateWebStore },
  'knowledge.sqlite': { version: knowledgeSchemaVersion, migrate: (path: string) => new KnowledgeStore(path).close() },
  'telegram.sqlite': { version: telegramInboxVersion, migrate: (path: string) => new TelegramInbox(path, false).db.close() },
};
