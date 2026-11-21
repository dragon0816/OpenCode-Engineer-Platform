"""Compare a bounded synthetic workbook with the immutable D08 oracle."""

import hashlib
import io
import json
import sys
from pathlib import Path
from zipfile import ZipFile

from openpyxl import load_workbook

ORACLE_SHA = "28fa2ba20946adb8f49735017083eac9322f891d5cad743907afb1fdcf46b825"
TYPES = {"text": str, "decimal": float, "integer": int, "boolean": bool}


def verify(workbook_path, oracle_path):
    oracle_bytes = oracle_path.read_bytes()
    if hashlib.sha256(oracle_bytes).hexdigest() != ORACLE_SHA:
        raise ValueError("oracle hash")
    oracle = json.loads(oracle_bytes)
    with workbook_path.open("rb") as source:
        data = source.read(256 * 1024 + 1)
    if not 0 < len(data) <= 256 * 1024:
        raise ValueError("workbook size")
    with ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 64 or sum(part.file_size for part in entries) > 1024 * 1024:
            raise ValueError("archive limits")

    book = load_workbook(io.BytesIO(data), data_only=False, keep_links=False)
    count = 0
    try:
        if book.sheetnames != [sheet["name"] for sheet in oracle["sheets"]]:
            raise ValueError("sheet names or order")
        for expected in oracle["sheets"]:
            sheet = book[expected["name"]]
            if sheet.calculate_dimension() != expected["range"]:
                raise ValueError("sheet range")
            for location, spec in expected["cells"].items():
                cell = sheet[location]
                if cell.data_type == "f" or type(cell.value) is not TYPES[spec["type"]] or cell.value != spec["value"]:
                    raise ValueError(f'{expected["name"]}.{location} type or value')
                count += 1
        return count
    finally:
        book.close()


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "cells": verify(Path(sys.argv[1]), Path(sys.argv[2]))}))
    except ValueError as error:
        reason = str(error)
        if reason not in {"oracle hash", "workbook size", "archive limits", "sheet names or order", "sheet range"} and not reason.endswith(" type or value"):
            reason = "invalid workbook"
        print(json.dumps({"ok": False, "reason": reason}))
        sys.exit(1)
    except Exception:
        print(json.dumps({"ok": False, "reason": "invalid workbook"}))
        sys.exit(1)
