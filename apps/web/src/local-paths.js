export function pastedLocalPaths(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length > 10) return [];
  const paths = lines.map((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  });
  return paths.every((path) => /^[a-z]:[\\/][^:*?"<>|\x00-\x1f]+$/i.test(path)) ? paths : [];
}
