import { writeFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { workbook } from './workbook.ts';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const source = Buffer.concat(chunks).toString('utf8');
const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
});
try {
  // Define the only workbook API inside the context. No host objects or functions cross into it.
  const result = runInContext(`
    (() => {
      let output;
      const encode = JSON.stringify;
      const writeWorkbook = (sheets) => {
        if (output !== undefined) throw new Error('Workbook already written');
        output = encode(sheets);
      };
      (() => { "use strict";\n${source}\n })();
      return output;
    })()
  `, context, { timeout: 1_000 }) as unknown;
  if (result !== undefined) {
    if (typeof result !== 'string' || result.length > 64 * 1024) throw new Error('Invalid workbook result');
    writeFileSync('output.xlsx', workbook(JSON.parse(result)), { flag: 'wx' });
    console.log('Workbook written');
  }
} catch {
  console.error('Workbook program failed');
  process.exitCode = 1;
}
