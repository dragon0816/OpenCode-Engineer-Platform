"""Bounded, synthetic document conversion probe. Never dispatches model requests."""

import csv
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from ooxml_probe import validate_workbook
from staged_attachment import staged_bytes

BASE = Path("tests/fixtures/attachments")
ORACLE = {
    "量測": [["Item", "Limit", "Enabled"], ["SYN-48B", 12.5, True], ["SYN-61A", 0, False]],
    "Notes": [["Code", "Comment"], ["R1", "合成資料"], ["R2", "a,b"]],
}


def workbook_rows(content):
    widths = validate_workbook(content)
    os.environ['OPENPYXL_LXML'] = 'False'
    os.environ['OPENPYXL_DEFUSEDXML'] = 'True'
    from openpyxl import load_workbook
    from openpyxl.xml import DEFUSEDXML, LXML

    if not DEFUSEDXML or LXML:
        raise RuntimeError("openpyxl XML policy not active")
    book = load_workbook(io.BytesIO(content), read_only=True, data_only=False, keep_links=False)
    try:
        if book.sheetnames != list(ORACLE):
            raise ValueError("worksheet names or count")
        result = {}
        for sheet in book.worksheets:
            # Reset worksheet dimensions so self-reported bounds cannot hide additional rows.
            sheet.reset_dimensions()
            table = []
            for number, row in enumerate(sheet.iter_rows(max_col=widths[sheet.title]), 1):
                if number > 200 or len(row) > 24:
                    raise ValueError("row or column count")
                if any(cell.data_type in {"f", "e"} for cell in row):
                    raise ValueError("formula or cell error")
                values = [cell.value for cell in row]
                if any(type(value) not in (str, int, float, bool, type(None)) for value in values):
                    raise ValueError("unsupported cell type")
                if any(isinstance(value, str) and len(value) > 1024 for value in values):
                    raise ValueError("cell length")
                table.append(values)
            result[sheet.title] = table
        return result
    finally:
        book.close()


def convert(rows):
    content = io.StringIO(newline="")
    writer = csv.writer(content, lineterminator="\n")
    writer.writerow(["sheet", "row", "cell", "json_value"])
    for sheet, table in rows.items():
        for number, row in enumerate(table, 1):
            for column, value in enumerate(row):
                writer.writerow([sheet, number, f"{chr(65 + column)}{number}", json.dumps(value, ensure_ascii=False)])
    return content.getvalue().encode("utf-8")


def verify(csv_data):
    seen = set()
    for row in csv.DictReader(io.StringIO(csv_data.decode("utf-8"))):
        sheet, index, cell = row["sheet"], int(row["row"]), row["cell"]
        if not re.fullmatch(r"[A-X][1-9][0-9]*", cell) or sheet not in ORACLE or not 1 <= index <= len(ORACLE[sheet]):
            raise ValueError("invalid cell locator")
        column = ord(cell[0]) - ord("A")
        if column >= len(ORACLE[sheet][index - 1]):
            raise ValueError("invalid cell column")
        locator = (sheet, cell)
        expected = ORACLE[sheet][index - 1][column]
        actual = json.loads(row["json_value"])
        if locator in seen or cell != f"{chr(65 + column)}{index}" or type(expected) is not type(actual) or expected != actual:
            raise ValueError("cell oracle mismatch")
        seen.add(locator)
    if len(seen) != sum(len(row) for table in ORACLE.values() for row in table):
        raise ValueError("cell coverage")
    return len(seen)


def pdf_text(content):
    result = subprocess.run([sys.executable, str(Path(__file__).with_name('pdf-worker.py'))], input=content,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=5)
    return json.loads(result.stdout)


def main():
    out = Path('.phase0/attachments').absolute()
    out.mkdir(parents=True, exist_ok=True)
    if out.resolve(strict=True) != out:
        raise ValueError("invalid staging parent")
    with tempfile.TemporaryDirectory(dir=out, prefix='stage-') as temporary:
        root = Path(temporary)
        for name in ('table.xlsx', 'marker.pdf', 'scanned.pdf', 'marker.png'):
            shutil.copyfile(BASE / name, root / name)
        xlsx = staged_bytes(root, 'table.xlsx')
        text_pdf = staged_bytes(root, 'marker.pdf')
        scan_pdf = staged_bytes(root, 'scanned.pdf')
        png = staged_bytes(root, 'marker.png')
    rows = workbook_rows(xlsx)
    csv_data = convert(rows)
    cells = verify(csv_data)
    if pdf_text(text_pdf) != "PRINT-2746":
        raise ValueError("text PDF oracle")
    if pdf_text(scan_pdf) != "OCR_REQUIRED":
        raise ValueError("scanned PDF oracle")
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("PNG signature")
    (out / "table.csv").write_bytes(csv_data)
    print(json.dumps({"xlsx_sha256": hashlib.sha256(xlsx).hexdigest(), "csv_sha256": hashlib.sha256(csv_data).hexdigest(),
                      "cells": cells, "sheets": len(rows), "sheet_names": list(rows), "pdf": "PRINT-2746", "scan": "OCR_REQUIRED", "png": "signature"}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Attachment probe failed ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
