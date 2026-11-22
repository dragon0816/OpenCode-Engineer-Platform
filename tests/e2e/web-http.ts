import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { dataDirectory } from './test-data.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const real = process.argv.includes('--real');
const base = dataDirectory();
const root = join(base, 'Phase 2 合成資料');
mkdirSync(root);
const audit = mkdtempSync(join(root, 'launch-'));
const profile = join(root, 'profile');
mkdirSync(profile);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const fixture = (name: string) => readFileSync(join('tests/fixtures/attachments', name));
const cases = [
  { name: 'marker.png', mime: 'image/png', agent: 'inspector', expected: 'ORBIT-7349',
    prompt: 'Read the exact identifier printed in the attached synthetic screenshot. Reply with only that identifier.' },
  { name: 'marker.pdf', mime: 'application/pdf', agent: 'inspector', expected: 'PRINT-2746',
    prompt: 'Read the exact identifier printed in the attached synthetic PDF. Reply with only that identifier.' },
  { name: 'table.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', agent: 'workbook',
    expected: 'SYN-48B', prompt: 'Copy the two tables in the attached synthetic workbook, preserving sheet names, cell values and types. In your final reply identify the first Item in the first table.' },
] as const;
const sheetData = [
  { name: '量測', rows: [['Item', 'Limit', 'Enabled'], ['SYN-48B', 12.5, true], ['SYN-61A', 0, false]] },
  { name: 'Notes', rows: [['Code', 'Comment'], ['R1', '合成資料'], ['R2', 'a,b']] },
];

const synthetic: typeof fetch = async (_target, init) => {
  const { model, messages } = JSON.parse(String(init?.body)) as WireRequest;
  const input = JSON.stringify(messages.find((message) => message.role === 'user')?.content);
  if (input.includes('screenshot')) {
    assert.ok(input.includes(fixture('marker.png').toString('base64')));
    return completion(model, [{ role: 'assistant', content: 'ORBIT-7349' }], 'stop');
  }
  if (input.includes('synthetic PDF')) {
    assert.ok(input.includes(fixture('marker.pdf').toString('base64')));
    return completion(model, [{ role: 'assistant', content: 'PRINT-2746' }], 'stop');
  }
  assert.ok(input.includes('SYN-48B') && input.includes('合成資料') && input.includes('Row 2'));
  const path = input.match(/generated\/[a-f\d-]+\.json/)?.[0];
  assert.ok(path);
  if (!messages.some((message) => message.role === 'tool')) {
    return completion(model, toolCall(0, 'call_oep_xlsx', 'write', { path, content: JSON.stringify(sheetData) }), 'tool_calls');
  }
  return completion(model, [{ role: 'assistant', content: 'SYN-48B' }], 'stop');
};

console.log(JSON.stringify({ mode: real ? 'real' : 'synthetic', base, audit }));
const runtime = await startRuntime(audit, real ? undefined : {
  url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-web', fetch: synthetic,
}, profile);
try {
  const adapter = await startAdapter(root, runtime, () => undefined);
  try {
    const launch = new URL(adapter.pairURL());
    const origin = launch.origin;
    const ticket = new URLSearchParams(launch.hash.slice(1)).get('pair');
    const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await paired.json();
    const auth = { cookie, origin, 'x-oep-csrf': csrf };
    const api = (path: string, data?: object) => fetch(origin + path, data === undefined ? { headers: auth } : {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    let passed = 0;
    for (const item of cases) {
      const started = Date.now();
      const id = randomUUID();
      let sessionID: string | undefined;
      let outcome: string | undefined;
      let artifact: { path: string; sha256: string } | undefined;
      let matched = false;
      let failure: string | undefined;
      try {
        const created = await api('/api/sessions', { agent: item.agent });
        assert.equal(created.status, 201);
        sessionID = (await created.json()).id;
        const route = `/api/sessions/${sessionID}`;
        const uploaded = await fetch(`${origin}${route}/attachments`, { method: 'POST',
          headers: { ...auth, 'content-type': item.mime, 'x-oep-filename': encodeURIComponent(item.name) }, body: fixture(item.name) });
        assert.equal(uploaded.status, 201);
        const attachment = await uploaded.json();
        assert.equal(attachment.sha256, sha256(fixture(item.name)));
        assert.equal(attachment.converted, item.agent === 'workbook');
        const sent = await api(`${route}/turns`, { id, text: item.prompt, attachments: [attachment.id], workbook: item.agent === 'workbook' });
        assert.equal(sent.status, 202);
        for (let attempt = 0; attempt < 125; attempt++) {
          const state = await (await api(`${route}/state`)).json();
          const run = state.runs.find((run: { id: string }) => run.id === id);
          outcome = run?.state;
          if (outcome === 'failed') throw new Error(run.error);
          if (outcome === 'verified') {
            const replies = state.messages.filter((message: { role: string }) => message.role === 'assistant');
            matched = replies.some((message: { text: string }) => message.text.includes(item.expected));
            if (item.agent === 'workbook') {
              const output = await api(`${route}/artifacts/${id}`);
              assert.equal(output.status, 200);
              const bytes = Buffer.from(await output.arrayBuffer());
              const hash = sha256(bytes);
              assert.equal(hash, run.artifact.sha256);
              assert.equal(hash, output.headers.get('x-oep-sha256'));
              const path = join(audit, 'downloaded.xlsx');
              writeFileSync(path, bytes, { flag: 'wx' });
              artifact = { path, sha256: hash };
              const { convertWorkbook } = await import('../../apps/adapter/src/runs/attachments.ts');
              const reference = await convertWorkbook(fixture('table.xlsx'));
              assert.deepEqual(await convertWorkbook(bytes), reference);
              if (!real) {
                const unrelated = await api('/api/sessions', { agent: 'inspector' });
                assert.equal(unrelated.status, 201);
                const foreignID = (await unrelated.json()).id;
                assert.equal((await api(`/api/sessions/${foreignID}/artifacts/${id}`)).status, 404);
                writeFileSync(join(root, 'artifacts', id, 'output.xlsx'), 'synthetic tampering');
                assert.equal((await api(`${route}/artifacts/${id}`)).status, 409);
              }
            }
            assert.ok(matched, 'Expected fixture value missing from the assistant reply');
            passed++;
            break;
          }
          await delay(1_000);
        }
        assert.equal(outcome, 'verified');
      } catch (error) {
        failure = error instanceof Error ? error.message.split('\n')[0] : 'Unknown failure';
      } finally {
        const record = { alias: runtime.alias, case: item.name, sessionID, runID: id, outcome, matched,
          artifact, failure, fixtureSha256: sha256(fixture(item.name)), elapsedMs: Date.now() - started };
        appendFileSync(join(audit, 'web-attempts.jsonl'), `${JSON.stringify(record)}\n`);
        console.log(JSON.stringify(record));
      }
    }
    assert.equal(passed, cases.length);
  } finally { await adapter.close(); }
} finally {
  const stopped = await runtime.stop();
  console.log(JSON.stringify(stopped));
  assert.equal(stopped.orphans, 0);
}
