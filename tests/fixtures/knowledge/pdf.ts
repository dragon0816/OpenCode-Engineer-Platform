export function pdf(contents: string[]) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count ' + contents.length + ' /Kids [' + contents.map((_, i) => (4 + i * 2) + ' 0 R').join(' ') + '] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i, text] of contents.entries()) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' +
      (5 + i * 2) + ' 0 R >>', '<< /Length ' + Buffer.byteLength(text) + ' >>\nstream\n' + text + '\nendstream');
  }
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(result);
  result += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) result += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(result + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

export function stream(text: string) { return 'BT /F1 12 Tf 40 700 Td (' + text + ') Tj ET'; }
