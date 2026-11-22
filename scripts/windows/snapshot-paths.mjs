const storeFiles = ['runs.sqlite', 'web.sqlite', 'telegram-chat.sqlite', 'knowledge.sqlite', 'telegram.sqlite'];
const knownDatabases = new Set([
  ...['', 'web/'].flatMap((prefix) => storeFiles.map((name) => prefix + name)),
  'web/profile/data/opencode/opencode.db',
]);

export function isOepDatabase(name) {
  return knownDatabases.has(name.toLowerCase());
}

export function diagnosticPath(name) {
  return name.replaceAll('\\', '/').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '�').replaceAll('】', '］');
}
