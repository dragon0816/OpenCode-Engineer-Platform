import { strToU8, zipSync } from 'fflate';

type Cell = string | number | boolean;
type Sheet = { name: string; rows: Cell[][] };
const ns = 'http://schemas.openxmlformats.org';
const spreadsheet = `${ns}/spreadsheetml/2006/main`;
const rel = `${ns}/officeDocument/2006/relationships`;
const rels = `${ns}/package/2006/relationships`;
const declaration = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeXml(text: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(text)) throw new Error('Invalid XML text');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function isCell(value: unknown): value is Cell {
  return typeof value === 'string' && value.length <= 512 || typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'boolean';
}

function checkSheets(value: unknown): asserts value is Sheet[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) throw new Error('Invalid workbook sheets');
  const names = new Set<string>();
  for (const sheet of value) {
    if (!sheet || typeof sheet.name !== 'string' || !sheet.name || sheet.name.length > 31 ||
        /[\\/*?:\[\]]/.test(sheet.name) || names.has(sheet.name.toLowerCase()) ||
        !Array.isArray(sheet.rows) || !sheet.rows.length || sheet.rows.length > 20 ||
        !sheet.rows.every((row: unknown) => Array.isArray(row) && row.length > 0 && row.length <= 12 && row.every(isCell))) {
      throw new Error('Invalid workbook sheet');
    }
    names.add(sheet.name.toLowerCase());
  }
}

const workbookEntryTime = new Date(2000, 0, 1);

export function workbook(value: unknown) {
  checkSheets(value);
  const entries: Record<string, Uint8Array> = {};
  const add = (name: string, xml: string) => { entries[name] = strToU8(declaration + xml); };
  const sheetXML = value.map(({ name }, index) =>
    `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const part = (index: number) => `worksheets/sheet${index + 1}.xml`;
  const link = (id: number, kind: string, target: string) => `<Relationship Id="rId${id}" Type="${rel}/${kind}" Target="${target}"/>`;
  const links = value.map((_, index) => link(index + 1, 'worksheet', part(index))).join('');
  const format = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  const overrides = value.map((_, index) => `<Override PartName="/xl/${part(index)}" ContentType="${format}worksheet+xml"/>`).join('');
  add('[Content_Types].xml', `<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="${format}sheet.main+xml"/>${overrides}</Types>`);
  add('_rels/.rels', `<Relationships xmlns="${rels}">${link(1, 'officeDocument', 'xl/workbook.xml')}</Relationships>`);
  add('xl/workbook.xml', `<workbook xmlns="${spreadsheet}" xmlns:r="${rel}"><sheets>${sheetXML}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${rels}">${links}</Relationships>`);
  value.forEach(({ rows }, index) => {
    const data = rows.map((row, rowIndex) => {
      const cells = row.map((cell, column) => {
        const ref = `${String.fromCharCode(65 + column)}${rowIndex + 1}`;
        if (typeof cell === 'string') return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
        if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${Number(cell)}</v></c>`;
        return `<c r="${ref}"><v>${cell}</v></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    add(`xl/${part(index)}`, `<worksheet xmlns="${spreadsheet}"><sheetData>${data}</sheetData></worksheet>`);
  });
  // A fixed entry time keeps the same workbook data byte-identical across runs.
  return zipSync(entries, { mtime: workbookEntryTime });
}
