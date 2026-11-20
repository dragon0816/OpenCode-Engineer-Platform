"""Create the original synthetic attachment fixtures with repeatable bytes."""

import io
import re
import struct
import zlib
from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from openpyxl import Workbook

FIXTURES = Path("tests/fixtures/attachments")
GLYPHS = {
    "O": "01110100011000110001100011000101110",
    "R": "11110100011000111110101001001010001",
    "B": "11110100011000111110100011000111110",
    "I": "11111001000010000100001000010011111",
    "T": "11111001000010000100001000010000100",
    "-": "00000000000000011111000000000000000",
    "7": "11111000010001000100010000100001000",
    "3": "11110000010000101110000010000111110",
    "4": "00010001100101010010111110001000010",
    "9": "01110100011000101111000010000101110",
}


def marker_pixels():
    text = "ORBIT-7349"
    scale = 6
    width, height = (len(text) * 6 + 4) * scale, 11 * scale
    pixels = bytearray(b"\xff" * (width * height))
    for i, letter in enumerate(text):
        for offset, bit in enumerate(GLYPHS[letter]):
            if bit == "1":
                x = (i * 6 + offset % 5 + 2) * scale
                y = (offset // 5 + 2) * scale
                for row in range(y, y + scale):
                    pixels[row * width + x : row * width + x + scale] = b"\x00" * scale
    return width, height, bytes(pixels)


def png(width, height, pixels):
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    scanlines = b"".join(b"\x00" + pixels[row : row + width] for row in range(0, len(pixels), width))
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")


def pdf(width, height, pixels=None, *, lines=None):
    def stream(properties, payload):
        return b"<< " + properties + f" /Length {len(payload)} >>\nstream\n".encode() + payload + b"\nendstream"

    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]
    resource = "/XObject << /Marker 5 0 R >>" if pixels else "/Font << /F1 5 0 R >>"
    objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << {resource} >> /Contents 4 0 R >>".encode())
    if pixels:
        objects.append(stream(b"", f"q {width} 0 0 {height} 0 0 cm /Marker Do Q".encode()))
        props = f"/Type /XObject /Subtype /Image /Width {width} /Height {height} /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode"
        objects.append(stream(props.encode(), zlib.compress(pixels)))
    else:
        payload = b"BT /F1 18 Tf 20 35 Td (PRINT-2746) Tj ET"
        if lines is not None:
            def literal(line):
                return line.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')

            text = ' T* '.join(f'({literal(line)}) Tj' for line in lines)
            payload = f'BT /F1 10 Tf 14 TL 24 {height - 30} Td {text} ET'.encode('ascii')
        objects.append(stream(b"", payload))
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, content in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode() + content + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(result)


def workbook():
    book = Workbook()
    book.properties.creator = "OEP synthetic fixture"
    book.active.title = "量測"
    for row in [["Item", "Limit", "Enabled"], ["SYN-48B", 12.5, True], ["SYN-61A", 0, False]]:
        book.active.append(row)
    notes = book.create_sheet("Notes")
    for row in [["Code", "Comment"], ["R1", "合成資料"], ["R2", "a,b"]]:
        notes.append(row)
    return stable_workbook(book)


def stable_workbook(book):
    original = io.BytesIO()
    book.save(original)
    stable = io.BytesIO()
    with ZipFile(original) as source, ZipFile(stable, "w") as target:
        for name in sorted(source.namelist()):
            data = source.read(name)
            if name == "docProps/core.xml":
                data = re.sub(rb"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", datetime(2026, 1, 1).isoformat().encode() + b"Z", data)
            target.writestr(ZipInfo(name, (2026, 1, 1, 0, 0, 0)), data, compress_type=ZIP_DEFLATED, compresslevel=9)
    return stable.getvalue()


def main():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    marker = marker_pixels()
    for name, data in {
        "marker.png": png(*marker),
        "marker.pdf": pdf(210, 80),
        "scanned.pdf": pdf(*marker),
        "table.xlsx": workbook(),
    }.items():
        (FIXTURES / name).write_bytes(data)


if __name__ == "__main__":
    main()
