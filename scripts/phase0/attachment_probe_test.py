"""Synthetic regression checks for archive policy and native staged handles."""

import io
import os
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from attachment_probe import BASE, ORACLE, pdf_text, workbook_rows
from ooxml_probe import validate_workbook
from staged_attachment import staged_bytes


def rewrite(transform):
    output = io.BytesIO()
    with ZipFile(BASE / 'table.xlsx') as source, ZipFile(output, 'w') as target:
        for name in source.namelist():
            title, data = transform(name, source.read(name))
            target.writestr(title, data)
    return output.getvalue()


class AttachmentProbeTest(unittest.TestCase):
    def test_relationships_cover_nonstandard_extension_and_reject_dtd(self):
        original = 'xl/worksheets/sheet1.xml'
        alternate = 'xl/worksheets/sheet1.part'

        def transform(name, data):
            if name in ('[Content_Types].xml', 'xl/_rels/workbook.xml.rels'):
                data = data.replace(original.encode(), alternate.encode())
            return (alternate if name == original else name), data

        validate_workbook(rewrite(transform))

        def with_dtd(name, data):
            title, raw = transform(name, data)
            return title, (b'<!DOCTYPE worksheet>' + raw if title == alternate else raw)

        with self.assertRaisesRegex(Exception, 'DTDForbidden'):
            validate_workbook(rewrite(with_dtd))

    def test_reject_external_relationship_and_wide_row_before_openpyxl(self):
        def external(name, data):
            if name == 'xl/_rels/workbook.xml.rels':
                data = data.replace(b'Target="styles.xml"', b'TargetMode="External" Target="https://fixture.invalid/"')
            return name, data

        with self.assertRaisesRegex(ValueError, 'relationship'):
            validate_workbook(rewrite(external))

        def wide(name, data):
            if name == 'xl/worksheets/sheet1.xml':
                data = data.replace(b'r="A1"', b'r="XFD1"')
            return name, data

        with self.assertRaisesRegex(ValueError, 'locator'):
            validate_workbook(rewrite(wide))

    def test_reject_all_rows_and_children_that_openpyxl_would_parse_outside_the_prechecked_shape(self):
        from unittest.mock import patch

        cases = [
            (b'</sheetData>', b'</sheetData><row r="4"><c r="Y4"/></row>', 'row outside'),
            (b'<c r="A1"', b'<alias r="Y1"', 'non-cell child'),
            (b'</sheetData>', b'</sheetData><c r="A4"/>', 'cell outside'),
            (b'<c r="A1"', b'<c r="A2"', 'locator limit'),
        ]
        for search, replacement, error in cases:
            with self.subTest(error=error):
                def transform(name, data):
                    if name == 'xl/worksheets/sheet1.xml':
                        data = data.replace(search, replacement, 1)
                        if error == 'non-cell child':
                            data = data.replace(b'</c>', b'</alias>', 1)
                    return name, data

                with patch('openpyxl.load_workbook', side_effect=AssertionError('preflight allowed allocation')):
                    with self.assertRaisesRegex(ValueError, error):
                        workbook_rows(rewrite(transform))

    def test_sheet_oracle_checks_actual_names_and_count_including_empty_sheet(self):
        original = (BASE / 'table.xlsx').read_bytes()
        self.assertEqual(list(workbook_rows(original)), list(ORACLE))
        from openpyxl import load_workbook

        handle = io.BytesIO()
        book = load_workbook(io.BytesIO(original))
        try:
            book.create_sheet('Unexpected empty sheet')
            book.save(handle)
        finally:
            book.close()
        with self.assertRaisesRegex(ValueError, 'worksheet names or count'):
            workbook_rows(handle.getvalue())

    def test_staged_handle_rejects_hardlink_and_traversal(self):
        parent = Path('.phase0').absolute()
        parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent, prefix='staged-probe-test-') as temporary:
            root = Path(temporary)
            origin = root / 'original.pdf'
            origin.write_bytes(b'synthetic')
            self.assertEqual(staged_bytes(root, origin.name), b'synthetic')
            os.link(origin, root / 'second.pdf')
            with self.assertRaisesRegex(ValueError, 'identity'):
                staged_bytes(root, 'second.pdf')
            with self.assertRaisesRegex(ValueError, 'name'):
                staged_bytes(root, '../original.pdf')

    def test_limited_pdf_worker_extracts_valid_fixture_and_rejects_page_limit(self):
        from pypdf import PdfWriter

        self.assertEqual(pdf_text((BASE / 'marker.pdf').read_bytes()), 'PRINT-2746')
        self.assertEqual(pdf_text((BASE / 'scanned.pdf').read_bytes()), 'OCR_REQUIRED')
        writer = PdfWriter()
        for _ in range(6):
            writer.add_blank_page(width=72, height=72)
        content = io.BytesIO()
        writer.write(content)
        with self.assertRaises(Exception):
            pdf_text(content.getvalue())


if __name__ == '__main__':
    unittest.main()
