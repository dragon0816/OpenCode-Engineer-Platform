"""Reproduce the synthetic D08 smoke fixture and verify its materialized cells."""

import json
from pathlib import Path

from openpyxl import Workbook, load_workbook

from attachment_fixtures import pdf, stable_workbook

ROOT = Path('tests/fixtures/d08')
PDF_LINES = [
    'D08 synthetic procedure XD-01 - minimal smoke',
    'Create exactly two sheets in this order: Readings, Run. No formulas.',
    'Readings A1:C1 (text): Sample | Voltage | Passed',
    'Readings A2:C2: SYN-A (text) | 1.25 V (decimal) | TRUE (boolean)',
    'Readings A3:C3: SYN-B (text) | 0.75 V (decimal) | FALSE (boolean)',
    'Run A1:B1 (text): Run ID | Count',
    'Run A2:B2: SYN-D08-01 (text) | 2 (integer)',
    'Check exact cell values and types. Numeric absolute tolerance: 0.',
]


def main():
    oracle = json.loads((ROOT / 'oracle.json').read_text('utf-8'))
    book = Workbook()
    book.remove(book.active)
    for expected in oracle['sheets']:
        sheet = book.create_sheet(expected['name'])
        for location, cell in expected['cells'].items():
            sheet[location] = cell['value']
    (ROOT / 'expected.xlsx').write_bytes(stable_workbook(book))
    (ROOT / 'sop.pdf').write_bytes(pdf(490, 180, lines=PDF_LINES))

    types = {'text': str, 'decimal': float, 'integer': int, 'boolean': bool}
    actual = load_workbook(ROOT / 'expected.xlsx', read_only=True)
    try:
        if actual.sheetnames != [sheet['name'] for sheet in oracle['sheets']]:
            raise ValueError('Sheet order differs from the proposed oracle')
        for expected in oracle['sheets']:
            sheet = actual[expected['name']]
            if sheet.calculate_dimension() != expected['range']:
                raise ValueError('Cell range differs from the proposed oracle')
            for location, cell in expected['cells'].items():
                value = sheet[location].value
                if type(value) is not types[cell['type']] or value != cell['value']:
                    raise ValueError('Cell differs from the proposed oracle')
        print('D08 smoke fixture: 2 sheets, 13 exact cells.')
    finally:
        actual.close()


if __name__ == '__main__':
    main()
