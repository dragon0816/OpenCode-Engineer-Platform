import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const supported = /(?:\.(?:js|mjs|ts|py|ps1|vbs|cs|json|yml|txt|html|css|sql)|\/pre-commit)$/;
let checked = 0;
for (const file of files.filter((name) => supported.test(name))) {
  const source = readFileSync(file, 'utf8');
  if (!source.endsWith('\n') || /[\t ]\r?$/m.test(source)) {
    console.error(`Whitespace or missing final newline in ${file}`);
    process.exitCode = 1;
  }
  if (file.endsWith('.json')) JSON.parse(source);
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  checked++;
}
console.log(`Checked ${checked} source and configuration files.`);
