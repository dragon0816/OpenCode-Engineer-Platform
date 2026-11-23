"""Bounded PDF page rasterization, with no intermediate files."""

import struct
import zlib


def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def _png(bitmap):
    width, height = bitmap.width, bitmap.height
    pixels = memoryview(bitmap.buffer).cast("B")
    scanlines = bytearray((1 + width * 3) * height)
    for row in range(height):
        start = row * bitmap.stride
        offset = row * (1 + width * 3) + 1
        scanlines[offset:offset + width * 3] = pixels[start:start + width * 3]
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) +
            _chunk(b"IDAT", zlib.compress(scanlines, level=1)) + _chunk(b"IEND", b""))


class PdfRaster:
    def __init__(self, data):
        import pypdfium2

        self.document = pypdfium2.PdfDocument(data)
        self.format = pypdfium2.raw.FPDFBitmap_BGR

    def close(self):
        self.document.close()

    def page(self, number, limit):
        page = self.document[number - 1]
        try:
            longest = max(page.get_size())
            for cap in (2600, 1600):
                bitmap = page.render(scale=min(240 / 72, cap / longest), rev_byteorder=True,
                                     force_bitmap_format=self.format)
                try:
                    png = _png(bitmap)
                finally:
                    bitmap.close()
                if len(png) <= limit:
                    return png
            raise ValueError("Image size")
        finally:
            page.close()
