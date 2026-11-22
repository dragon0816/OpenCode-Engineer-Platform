import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { TelegramRouter } from '../../apps/adapter/src/telegram/router.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { BiScheduler } from '../../packages/knowledge/src/jobs/scheduler.ts';

const [mode, ledger, knowledge] = process.argv.slice(2);
const inbox = new TelegramInbox(ledger);
const row = { update_id: 1, message: { chat: { type: 'private', id: 42 }, from: { id: 42 }, text: 'Synthetic crash intake' } };
if (mode === 'before') {
  inbox.db.function('crash_before_commit', () => process.exit(79));
  inbox.db.exec('CREATE TEMP TRIGGER crash BEFORE INSERT ON channel_cursors BEGIN SELECT crash_before_commit(); END;');
  inbox.admit('bi', '42', [row]);
} else if (mode === 'persist') {
  inbox.admit('bi', '42', [row]);
} else if (mode === 'effect') {
  const store = new KnowledgeStore(knowledge);
  const runtime = { knowledge: { reviewStore: store } } as unknown as Runtime;
  const router = new TelegramRouter(inbox, runtime, undefined!, undefined!);
  await router.handle(inbox.next('bi', 'work', Date.now())!, new AbortController().signal);
} else if (mode === 'send') {
  inbox.notify('bi', 'crash-send', 0, 'Synthetic unknown delivery');
  inbox.db.exec("UPDATE channel_outbound SET state='sending' WHERE account_id='telegram-bi'");
} else if (mode === 'schedule') {
  const store = new KnowledgeStore(knowledge);
  new BiScheduler(inbox.db, store).reconcile(Number(process.argv[5]));
} else if (mode === 'attempt') {
  const now = Number(process.argv[5]);
  const row = inbox.next('main', 'work', now)!;
  inbox.attempt(row, now, now + 6000);
}
process.exit(79);
