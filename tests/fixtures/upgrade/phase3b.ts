import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const attachmentPath = 'web/secondary/sessions/hidden/attachments/synthetic.txt';
export const artifactPath = 'web/secondary/artifacts/hidden-run/synthetic.xlsx';
export const fixtureMcpId = '0123456789abcdef0123456789abcdef';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

export function seedPhase3bFixture(root: string) {
  const web = join(root, 'web');
  mkdirSync(web, { recursive: true });
  function seed(name: string, schema: string) {
    const db = new DatabaseSync(join(web, name + '.sqlite'));
    db.exec(readFileSync(new URL('phase3b-' + schema + '.sql', import.meta.url), 'utf8'));
    return db;
  }
  function file(path: string, bytes: Buffer) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    return { device: 'fixture', inode: 'fixture', created: '1', modified: '1', changed: '1',
      bytes: bytes.length, sha256: hash(bytes) };
  }
  const original = file(attachmentPath, Buffer.from('synthetic attachment'));
  const projection = file(attachmentPath + '.preview', Buffer.from('synthetic preview'));
  const artifact = file(artifactPath, Buffer.from('synthetic artifact'));
  file('web/model-work/visible/input.txt', Buffer.from('synthetic model input'));
  file('web/profile/synthetic.txt', Buffer.from('original profile'));

  using sessions = seed('web', 'web');
  sessions.exec(`
    INSERT INTO web_sessions VALUES
      ('visible', 'upstream-web', 'inspector', 'synthetic-default', 1),
      ('hidden', 'upstream-secondary', 'workbook', 'synthetic-secondary', 2);
    INSERT INTO web_session_display VALUES ('hidden', 'Synthetic hidden session', 1);
    INSERT INTO web_session_project VALUES ('hidden', 'secondary');
    INSERT INTO web_session_knowledge_disabled VALUES ('hidden');
    INSERT INTO web_knowledge_settings VALUES (1, '', 0);
    INSERT INTO web_preferences VALUES (1, 'Synthetic assistant', 'Synthetic introduction', 'Synthetic instructions');
    INSERT INTO web_model_catalog VALUES (1, '["synthetic-default","synthetic-secondary"]', 1);
    INSERT INTO web_model_selection VALUES (1, '["synthetic-default","synthetic-secondary"]');
    INSERT INTO web_model_settings VALUES (1, 'synthetic-secondary');
    INSERT INTO runs VALUES ('visible-run', 'accepted', '{"id":"visible-run","state":"accepted"}');
    INSERT INTO run_events(run_id, at, state, record)
      VALUES ('visible-run', 1, 'accepted', '{"id":"visible-run","state":"accepted"}');
    INSERT INTO web_turns VALUES ('visible', 'visible-run', 'synthetic-request');
    INSERT INTO web_message_annotations VALUES ('hidden', 'message', 'Synthetic note', NULL, NULL);
  `);
  const avatar = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfT8AAAAASUVORK5CYII=', 'base64');
  sessions.prepare("INSERT INTO web_appearance VALUES (1, 'dark', 'compact', ?, 'image/png')").run(avatar);
  sessions.prepare('INSERT INTO web_project_folders VALUES (?, ?), (?, ?)')
    .run('default', join(root, 'external-default'), 'secondary', join(root, 'external-secondary'));
  sessions.prepare('INSERT INTO mcp_servers VALUES (?, ?, 1, 1)').run(fixtureMcpId, JSON.stringify({
    id: fixtureMcpId, transport: 'stdio', enabled: false, appliesToProjects: ['default', 'secondary'], environment: [],
  }));
  const record = JSON.stringify({ id: 'hidden-run', state: 'failed', workspace: join(web, 'secondary', 'model-work', 'hidden'),
    artifacts: [{ name: 'synthetic.xlsx', ...artifact }] });
  sessions.prepare("INSERT INTO runs VALUES ('hidden-run', 'failed', ?)").run(record);
  sessions.prepare("INSERT INTO run_events(run_id, at, state, record) VALUES ('hidden-run', 2, 'failed', ?)").run(record);
  sessions.exec("INSERT INTO web_turns VALUES ('hidden', 'hidden-run', 'synthetic-hidden-request');"
    + "INSERT INTO web_turn_replies VALUES ('hidden-run', 'message', 'Synthetic reply');");
  sessions.prepare("INSERT INTO attachments VALUES ('attachment', 'hidden', ?, ?)")
    .run(original.bytes + projection.bytes, JSON.stringify({ id: 'attachment', name: 'synthetic.txt', mime: 'text/plain',
      original, projection }));

  using chat = seed('telegram-chat', 'web');
  chat.exec(`
    INSERT INTO web_sessions VALUES ('telegram-session', 'upstream-telegram', 'inspector', 'synthetic-default', 3),
      ('unbound-session', 'upstream-unbound', 'inspector', 'synthetic-default', 4);
    INSERT INTO runs VALUES ('telegram-run', 'accepted', '{"id":"telegram-run","state":"accepted"}');
    INSERT INTO run_events(run_id, at, state, record)
      VALUES ('telegram-run', 3, 'accepted', '{"id":"telegram-run","state":"accepted"}');
    INSERT INTO web_turns VALUES ('telegram-session', 'telegram-run', 'synthetic-telegram-request');
  `);
  using telegram = seed('telegram', 'telegram');
  telegram.exec(`
    INSERT INTO telegram_sessions VALUES (17, 'telegram-session');
    INSERT INTO cursor VALUES ('main', 8), ('bi', 11);
    INSERT INTO inbox(bot, id, topic, payload) VALUES ('main', 7, 17, '{}');
    INSERT INTO outbox(bot, id, topic, text, state) VALUES
      ('main', 'original', 17, 'Synthetic pending', 'pending'),
      ('bi', 'previous-bi', 0, 'Synthetic uncertain', 'indeterminate');
    INSERT INTO bi_sources VALUES (10, 'synthetic source', 'awaiting_review', '', X'73796e746865746963', 'fixture', NULL, 'synthetic-bench');
    INSERT INTO bi_config VALUES ('target', 'synthetic-bench');
  `);
  telegram.prepare('INSERT INTO telegram_binding VALUES (?, ?)').run('main', hash(Buffer.from('synthetic fingerprint')));

  using knowledge = seed('knowledge', 'knowledge');
  knowledge.exec(`
    INSERT INTO reviews(id, vault, parent, original, draft, edit) VALUES
      ('pending-bi', 'synthetic-bench', 'gold.v2', '{}', '{}', 1);
    INSERT INTO review_edits VALUES ('pending-bi', 1, '{}');
    INSERT INTO ingest_jobs(id, payload, completed) VALUES ('telegram-bi-10', '{}', 1);
    INSERT INTO ingest_effects VALUES ('telegram-bi-10', 'pending-bi');
  `);
  return { web, avatar, original, projection, artifact };
}
