import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atRepo } from '../../apps/launcher/src/paths.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

export function workbookFixture() {
  const oracle = JSON.parse(readFileSync(atRepo('tests/fixtures/d08/oracle.json'), 'utf8'));
  return oracle.sheets.map((sheet: { name: string; cells: Record<string, { value: unknown }> }) => {
    const rows: unknown[][] = [];
    for (const [address, { value }] of Object.entries(sheet.cells)) {
      const row = Number(address.slice(1)) - 1;
      (rows[row] ??= []).push(value);
    }
    return { name: sheet.name, rows };
  }) as { name: string; rows: unknown[][] }[];
}

export function excelProviderFixture() {
  const source = `writeWorkbook(${JSON.stringify(workbookFixture())});`;
  const pdf = readFileSync(atRepo('tests/fixtures/d08/sop.pdf')).toString('base64');
  const fakeFetch: typeof fetch = async (_input, options) => {
    const { model, messages } = JSON.parse(String(options?.body)) as WireRequest;
    const user = JSON.stringify(messages.find((message) => message.role === 'user')?.content) ?? '';
    const nonce = user.match(/READY-[A-F0-9]{8}/)?.[0];
    if (nonce) return completion(model, [{ role: 'assistant', content: nonce }], 'stop');
    const markdown = user.includes('Read the local sop.md');
    const results = messages.filter((message) => message.role === 'tool');
    if (markdown && !results.length) return completion(model, toolCall(0, 'call_oep_read', 'read', { path: 'sop.md' }), 'tool_calls');
    if (markdown && !results.some((result) => result.tool_call_id === 'call_oep_read' && JSON.stringify(result.content).includes('1.25'))) {
      return new Response(null, { status: 400 });
    }
    if (!markdown && (!user.includes('Use the attached SOP PDF') || !user.includes('sop.pdf') || !user.includes(pdf))) {
      return new Response(null, { status: 400 });
    }
    const written = results.find((result) => result.tool_call_id === 'call_oep_write');
    if (!written) return completion(model, toolCall(0, 'call_oep_write', 'write', { path: 'program.js', content: source }), 'tool_calls');
    if (!JSON.stringify(written.content).includes('program.js')) return new Response(null, { status: 400 });
    return completion(model, [{ role: 'assistant', content: 'Written.' }], 'stop');
  };
  return { url: 'http://example.invalid/v1', key: randomBytes(24).toString('hex'), alias: 'synthetic-excel', fetch: fakeFetch };
}
