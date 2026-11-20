import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const rules = [
  ['private key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['credential token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|\d{7,12}:[A-Za-z0-9_-]{32,})\b/],
  ['embedded HTTP credentials', /https?:\/\/[^\s/@]+:[^\s/@]+@/i],
  ['assigned gateway secret', /\b(?:OEP_LITELLM_(?:API_KEY|TEST_API_KEY|BASE_URL)|LITELLM_MASTER_KEY)\s*[:=]\s*["']?\s*(?:https?:\/\/|(?:[A-Za-z0-9_+-]{20,})["'\s,;]|["'][^"'\s]{8,}["'])/i],
  ['private host URL', /https?:\/\/(?:[\w.-]+\.(?:internal|corp|local|lan)\b|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i],
];

export function detect(text, known = []) {
  const hits = rules.filter(([, rule]) => rule.test(text)).map(([name]) => name);
  if (known.some((value) => value && text.includes(value))) hits.push('runtime gateway value');
  return hits;
}

if (process.argv[2]) {
  try {
    const staged = process.argv[2] === '--staged';
    if (!staged && process.argv[2] !== '--tree') throw new Error('mode');
    const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    const paths = (staged ? git('diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z') : git('ls-files', '-z'))
      .toString('utf8').split('\0').filter(Boolean);
    const known = ['OEP_LITELLM_BASE_URL', 'OEP_LITELLM_API_KEY', 'OEP_LITELLM_TEST_API_KEY'].map((name) => process.env[name]);
    const counts = new Map();
    for (const path of paths) {
      const bytes = staged ? git('show', `:${path}`) : readFileSync(path);
      for (const match of new Set(detect(`${path}\n${bytes.toString('utf8')}`, known))) {
        counts.set(match, (counts.get(match) ?? 0) + 1);
      }
    }
    const hits = [...counts.values()].reduce((total, count) => total + count, 0);
    console.log(JSON.stringify({ mode: staged ? 'staged' : 'tree', files: paths.length, hits, rules: Object.fromEntries(counts) }));
    process.exitCode = hits ? 1 : 0;
  } catch {
    console.error('Secret scan could not read the requested Git content.');
    process.exitCode = 1;
  }
}
