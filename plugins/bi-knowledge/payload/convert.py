# Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/convert.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
"""Convert files into the immutable text OEP cites."""

import codecs
import io
import re

import html_markdown
from staging import source_digest

SOURCE_BYTES = 10 * 1024 * 1024
TEXT_BYTES = 160_000
MAX_PAGES = 120
MAX_SEGMENTS = 1500
TEXT_ENCODINGS = ("utf-8-sig", "cp950")


class ConversionError(Exception):
    pass


def decode_text(data):
    utf16 = data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))
    for encoding in ("utf-16",) if utf16 else TEXT_ENCODINGS:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ConversionError("encoding")


def _tidy(text):
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    joined = "\n".join(lines).strip("\n")
    return re.sub(r"\n{3,}", "\n\n", joined)


def pdf_pages(data, recognize):
    try:
        import pypdf
    except ImportError as error:
        raise ConversionError("pdf-unavailable") from error
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ConversionError("pdf-encrypted")
    if len(reader.pages) > MAX_PAGES:
        raise ConversionError("limit")
    from raster import PdfRaster

    raster = None
    try:
        for number, page in enumerate(reader.pages, start=1):
            try:
                body = _tidy(page.extract_text() or "")
            except Exception:
                body = ""
            if meaningful_layer(body):
                yield {"text": body, "status": "text-layer"}
                continue
            try:
                if raster is None:
                    raster = PdfRaster(data)
                image = raster.page(number, SOURCE_BYTES)
            except Exception:
                yield {"status": "failed", "warning": "render-failed"}
                continue
            yield recognize(number, "image/png", image)
    finally:
        if raster is not None:
            raster.close()


def meaningful_layer(body):
    if re.fullmatch(r"\s*(?:page|p\.)\s*\d+(?:\s*(?:of|/)\s*\d+)?\s*", body, re.IGNORECASE):
        return False
    letters = sum(character.isalpha() for character in body)
    readable = letters + sum(character.isdigit() for character in body)
    noise = sum(not character.isprintable() and not character.isspace() or character == "\ufffd" for character in body)
    return (letters >= 2 or readable >= 4) and noise * 4 <= readable


def image_kind(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    raise ConversionError("invalid")


def convert(kind, data, charset, recognize):
    title = ""
    pages = []
    if kind in ("pdf", "image"):
        segments = []
        remaining = TEXT_BYTES
        results = pdf_pages(data, recognize) if kind == "pdf" else [recognize(1, image_kind(data), data)]
        for number, result in enumerate(results, start=1):
            locator = f"page:{number}"
            body = _tidy(result.get("text", ""))
            remaining -= len(body.encode("utf-8"))
            if remaining < 0:
                raise ConversionError("limit")
            pages.append({"locator": locator, **{key: result[key] for key in ("status", "ocr", "warning") if key in result}})
            if body.strip():
                segments.append({"locator": locator, "text": body, **{key: result[key] for key in
                    ("ocr", "lines", "width", "height") if key in result}})
    elif kind == "html":
        title, segments = html_markdown.read(data, charset)
    elif kind == "text":
        body = _tidy(decode_text(data))
        segments = [
            {"locator": f"paragraph:{number}", "text": text}
            for number, text in enumerate(re.split(r"\n[ \t]*\n", body), 1) if text.strip()
        ]
    else:
        raise ConversionError("format")
    if not segments and not pages:
        raise ConversionError("empty")
    if len(segments) > MAX_SEGMENTS or sum(len(item["text"].encode("utf-8")) for item in segments) > TEXT_BYTES:
        raise ConversionError("limit")
    return {"sha256": source_digest(data), "title": title, "segments": segments, "pages": pages}
