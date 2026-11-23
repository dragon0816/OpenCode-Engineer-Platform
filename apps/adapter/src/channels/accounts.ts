import type { DatabaseSync } from 'node:sqlite';
import type { Binding } from './transport.ts';

export const legacyChannels = [
  { bot: 'main', accountId: 'telegram-main', credentialRef: 'OEP_TELEGRAM_MAIN_BOT_TOKEN', handler: 'chat' },
  { bot: 'bi', accountId: 'telegram-bi', credentialRef: 'OEP_TELEGRAM_BI_BOT_TOKEN', handler: 'bi_intake' },
] as const;
export const legacyAllowlistRef = 'OEP_TELEGRAM_ALLOWED_USER_ID';
export type LegacyChannel = typeof legacyChannels[number];
export type ChannelHandler = 'chat' | 'bi_intake';
export type ChannelAccount = Binding & {
  credentialRef: string;
  allowlistRef: string;
  handler: ChannelHandler;
  state: 'unverified' | 'enabled' | 'disabled';
  fingerprint: string | null;
};

export const telegramCredentialRef = /^OEP_TELEGRAM_[A-Z][A-Z0-9_]{0,63}_BOT_TOKEN$/;
export const managedTelegramCredentialRef = /^OEP_TELEGRAM_BOT_[A-F0-9]{32}_BOT_TOKEN$/;

export const legacyChannelAccounts = () => legacyChannels.map(({ accountId, credentialRef, handler, bot }) =>
  [accountId, 'telegram', null, credentialRef, legacyAllowlistRef, bot, handler, 'unverified', 1, 0, 0] as const);

export function migrateChannelAccounts(db: DatabaseSync) {
  db.exec(`CREATE TABLE channel_accounts (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL,
    account_fingerprint TEXT CHECK(length(account_fingerprint)=64 AND account_fingerprint NOT GLOB '*[^0-9a-f]*'),
    credential_ref TEXT NOT NULL UNIQUE, allowlist_ref TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    handler TEXT NOT NULL CHECK(handler IN ('chat','bi_intake')),
    state TEXT NOT NULL CHECK(state IN ('unverified','enabled','disabled')),
    binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(provider,account_fingerprint),
    CHECK(state <> 'enabled' OR account_fingerprint IS NOT NULL),
    CHECK(handler <> 'bi_intake' OR agent_id='bi')
  ) STRICT;
  CREATE TRIGGER agents_archive_without_enabled_channels BEFORE UPDATE OF state ON agents
    WHEN OLD.state='active' AND NEW.state='archived' AND EXISTS (
      SELECT 1 FROM channel_accounts WHERE agent_id=OLD.id AND state='enabled'
    ) BEGIN SELECT RAISE(ABORT,'An agent with enabled channels cannot be archived'); END;`);
  const insert = db.prepare('INSERT INTO channel_accounts VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const row of legacyChannelAccounts()) insert.run(...row);
}

const telegramSettingsSchema = `CREATE TABLE telegram_account_settings (
  account_id TEXT PRIMARY KEY REFERENCES channel_accounts(id),
  bot_name TEXT,
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1))
) STRICT`;

export function migrateTelegramSettings(db: DatabaseSync) { db.exec(telegramSettingsSchema); }

export function verifyTelegramSettings(db: DatabaseSync) {
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='telegram_account_settings'").get()?.sql;
  if (String(sql).replace(/\s+/g, ' ') !== telegramSettingsSchema.replace(/\s+/g, ' ')) {
    throw new Error('Telegram account settings do not match the migration');
  }
}
