"""Generate a PNG, an image-only PDF, and a mixed PDF from synthetic text."""

import struct
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, EncodedStreamObject, NameObject, NumberObject

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "plugins/bi-knowledge/payload"))
from raster import PdfRaster


def add_scan(writer, png, footer=False):
    width, height = struct.unpack_from(">II", png, 16)
    image_data = bytearray()
    offset = 8
    while offset < len(png):
        size, kind = struct.unpack_from(">I4s", png, offset)
        if kind == b"IDAT":
            image_data.extend(png[offset + 8:offset + 8 + size])
        offset += size + 12
    image = EncodedStreamObject()
    image._data = bytes(image_data)
    fields = {"Type": "/XObject", "Subtype": "/Image", "ColorSpace": "/DeviceRGB", "Width": width,
              "Height": height, "Filter": "/FlateDecode", "BitsPerComponent": 8}
    for key, value in fields.items():
        image[NameObject("/" + key)] = NameObject(value) if isinstance(value, str) else NumberObject(value)
    image[NameObject("/DecodeParms")] = DictionaryObject({NameObject("/" + key): NumberObject(value)
        for key, value in {"Predictor": 15, "Columns": width, "Colors": 3, "BitsPerComponent": 8}.items()})

    page = writer.add_blank_page(612, 792)
    resources = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Scan"): writer._add_object(image)})})
    page[NameObject("/Resources")] = resources
    draw = b"q 612 0 0 792 0 0 cm /Scan Do Q"
    if footer:
        resources[NameObject("/Font")] = DictionaryObject({NameObject("/F1"): DictionaryObject({
            NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        })})
        draw += b" BT /F1 10 Tf 35 25 Td (Page 2) Tj ET"
    contents = DecodedStreamObject()
    contents.set_data(draw)
    page[NameObject("/Contents")] = writer._add_object(contents)


root = Path(sys.argv[1])
original = root / "original.pdf"
raster = PdfRaster(original.read_bytes())
try:
    png = raster.page(2, 10 * 1024 * 1024)
    sparse = raster.page(3, 10 * 1024 * 1024)
finally:
    raster.close()
(root / "scan.png").write_bytes(png)
(root / "sparse.png").write_bytes(sparse)

scan = PdfWriter()
add_scan(scan, png)
scan.write(root / "scanned.pdf")
assert PdfReader(root / "scanned.pdf").pages[0].extract_text() == ""

mixed = PdfWriter()
mixed.add_page(PdfReader(original).pages[0])
add_scan(mixed, png, footer=True)
mixed.write(root / "mixed.pdf")
assert PdfReader(root / "mixed.pdf").pages[1].extract_text() == "Page 2"
