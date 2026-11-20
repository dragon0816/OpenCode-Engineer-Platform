"""Bounded, synthetic document conversion probe. Never dispatches model requests."""

import csv
import hashlib
import io
import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile

from openpyxl import load_workbook
from pypdf import PdfReader

BASE = Path("tests/fixtures/attachments")
MAX_FILE = 20 * 1024 * 1024
ORACLE = {
    "量測": [["Item", "Limit", "Enabled"], ["SYN-48B", 12.5, True], ["SYN-61A", 0, False]],
    "Notes": [["Code", "Comment"], ["R1", "合成資料"], ["R2", "a,b"]],
}


def bounded_bytes(path):
    with path.open("rb") as handle:
        content = handle.read(MAX_FILE + 1)
    if not 0 < len(content) <= MAX_FILE:
        raise ValueError("file size")
    return content


def workbook_rows(content):
    with ZipFile(io.BytesIO(content)) as archive:
        members = archive.infolist()
        if len(members) > 100 or len({member.filename for member in members}) != len(members):
            raise ValueError("archive entry count or duplication")
        if sum(member.file_size for member in members) > 4 * 1024 * 1024:
            raise ValueError("inflated size")
        for member in members:
            name = member.filename.lower()
            if member.file_size > 512 * 1024 or member.flag_bits & 1:
                raise ValueError("archive entry size or encryption")
            if "vbaproject" in name or "externallink" in name or "embeddings/" in name or ".." in name.split("/"):
                raise ValueError("unsupported archive member")
            if name.endswith((".xml", ".rels")):
                xml = archive.read(member)
                if b"\x00" in xml or b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
                    raise ValueError("unsupported XML declaration")
    book = load_workbook(io.BytesIO(content), read_only=True, data_only=False, keep_links=False)
    try:
        if not 0 < len(book.worksheets) <= 4:
            raise ValueError("sheet count")
        result = {}
        for sheet in book.worksheets:
            # Reset worksheet dimensions so self-reported bounds cannot hide additional rows.
            sheet.reset_dimensions()
            table = []
            for number, row in enumerate(sheet.iter_rows(), 1):
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
    reader = PdfReader(io.BytesIO(content), strict=True)
    if not 0 < len(reader.pages) <= 5 or reader.is_encrypted:
        raise ValueError("PDF page count or encryption")
    text = "\n".join(page.extract_text() for page in reader.pages).strip()
    return text if text else "OCR_REQUIRED"


def main():
    xlsx = bounded_bytes(BASE / "table.xlsx")
    csv_data = convert(workbook_rows(xlsx))
    cells = verify(csv_data)
    if pdf_text(bounded_bytes(BASE / "marker.pdf")) != "PRINT-2746":
        raise ValueError("text PDF oracle")
    if pdf_text(bounded_bytes(BASE / "scanned.pdf")) != "OCR_REQUIRED":
        raise ValueError("scanned PDF oracle")
    png = bounded_bytes(BASE / "marker.png")
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("PNG signature")
    out = Path(".phase0/attachments")
    out.mkdir(parents=True, exist_ok=True)
    (out / "table.csv").write_bytes(csv_data)
    print(json.dumps({"xlsx_sha256": hashlib.sha256(xlsx).hexdigest(), "csv_sha256": hashlib.sha256(csv_data).hexdigest(),
                      "cells": cells, "sheets": len(ORACLE), "pdf": "PRINT-2746", "scan": "OCR_REQUIRED", "png": "signature"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(f"Attachment probe failed ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
