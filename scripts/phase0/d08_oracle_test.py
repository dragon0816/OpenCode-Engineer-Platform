"""Check the approved D08 fixture against its documented immutable hashes and both SOP formats."""

import hashlib
import json
import unittest
from pathlib import Path

from openpyxl import load_workbook

from attachment_probe import pdf_text
from d08_fixture import ROOT

APPROVED = {
    'oracle.json': '28fa2ba20946adb8f49735017083eac9322f891d5cad743907afb1fdcf46b825',
    'expected.xlsx': 'd4816db2ceaf29c237b9a622805b007fb86ac90973141769ec0d3694b7d0b914',
}


def require_approved_hash(name, content):
    if hashlib.sha256(content).hexdigest() != APPROVED[name]:
        raise ValueError(f'Approved D08 fixture changed: {name}')


def verify_sop(markdown, pdf, oracle):
    readings, run = oracle['sheets']
    a, b = readings['cells'], run['cells']
    row = lambda cells, locations: [cells[location]['value'] for location in locations]
    header = row(a, ['A1', 'B1', 'C1'])
    north = row(a, ['A2', 'B2', 'C2'])
    south = row(a, ['A3', 'B3', 'C3'])
    run_header = row(b, ['A1', 'B1'])
    run_id, count = row(b, ['A2', 'B2'])
    yes_no = lambda value: 'TRUE' if value else 'FALSE'
    pdf_lines = [
        'D08 synthetic procedure XD-01 - minimal smoke',
        f"Create exactly two sheets in this order: {readings['name']}, {run['name']}. No formulas.",
        f"{readings['name']} A1:C1 (text): {' | '.join(header)}",
        f"{readings['name']} A2:C2: {north[0]} (text) | {north[1]:.2f} V (decimal) | {yes_no(north[2])} (boolean)",
        f"{readings['name']} A3:C3: {south[0]} (text) | {south[1]:.2f} V (decimal) | {yes_no(south[2])} (boolean)",
        f"{run['name']} A1:B1 (text): {' | '.join(run_header)}",
        f"{run['name']} A2:B2: {run_id} (text) | {count} (integer)",
        f"Check exact cell values and types. Numeric absolute tolerance: {b['B2']['absoluteTolerance']}.",
    ]
    markdown_lines = [
        f"1. 第一張工作表命名為 `{readings['name']}`。A1、B1、C1 填文字 `{'`、`'.join(header)}`。",
        f"2. 第二列依序填文字 `{north[0]}`、小數 `{north[1]:.2f}`（伏特）、布林 `{yes_no(north[2])}`。"
        f"第三列依序填文字 `{south[0]}`、小數 `{south[1]:.2f}`（伏特）、布林 `{yes_no(south[2])}`。",
        f"3. 第二張工作表命名為 `{run['name']}`。A1、B1 填文字 `{'`、`'.join(run_header)}`。A2 填文字 `{run_id}`，B2 填整數 `{count}`。",
        f"4. 核對每格型別和值。數值採精確相等，容差為 {b['B2']['absoluteTolerance']}。欄位 `{header[2]}` 為試算表布林值。",
    ]
    if pdf.splitlines() != pdf_lines:
        raise ValueError('PDF differs from the approved oracle')
    if markdown.splitlines()[-4:] != markdown_lines:
        raise ValueError('Markdown differs from the approved oracle')


class ApprovedOracleTest(unittest.TestCase):
    def test_approved_hashes_match_documentation_and_reject_drift(self):
        doc = Path('docs/validation/d08-oracle.md').read_text('utf-8')
        for name, digest in APPROVED.items():
            content = (ROOT / name).read_bytes()
            require_approved_hash(name, content)
            self.assertIn(f'`{digest}`', doc)
            with self.assertRaisesRegex(ValueError, 'fixture changed'):
                require_approved_hash(name, content + b'\n')

    def test_pdf_markdown_and_workbook_match_the_approved_cells(self):
        oracle = json.loads((ROOT / 'oracle.json').read_bytes())
        self.assertTrue(oracle['syntheticOnly'])
        self.assertEqual(oracle['status'], 'approved-minimal-smoke-oracle')
        markdown = (ROOT / 'sop.md').read_text('utf-8')
        extracted = pdf_text((ROOT / 'sop.pdf').read_bytes())
        verify_sop(markdown, extracted, oracle)
        with self.assertRaisesRegex(ValueError, 'PDF differs'):
            verify_sop(markdown, extracted.replace('1.25', '1.20'), oracle)
        with self.assertRaisesRegex(ValueError, 'Markdown differs'):
            verify_sop(markdown.replace('`Run`', '`Other`'), extracted, oracle)

        types = {'text': str, 'decimal': float, 'integer': int, 'boolean': bool}
        book = load_workbook(ROOT / 'expected.xlsx', read_only=True)
        try:
            self.assertEqual(book.sheetnames, [sheet['name'] for sheet in oracle['sheets']])
            self.assertEqual(sum(len(sheet['cells']) for sheet in oracle['sheets']), 13)
            for expected in oracle['sheets']:
                sheet = book[expected['name']]
                self.assertEqual(sheet.calculate_dimension(), expected['range'])
                for location, cell in expected['cells'].items():
                    self.assertNotEqual(sheet[location].data_type, 'f')
                    self.assertIs(type(sheet[location].value), types[cell['type']])
                    self.assertEqual(sheet[location].value, cell['value'])
                    if cell['type'] in {'decimal', 'integer'}:
                        self.assertEqual(cell['absoluteTolerance'], 0)
        finally:
            book.close()


if __name__ == '__main__':
    unittest.main()
