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


def pdf_pages(data):
    try:
        import pypdf
    except ImportError as error:
        raise ConversionError("pdf-unavailable") from error
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ConversionError("pdf-encrypted")
    if len(reader.pages) > MAX_PAGES:
        raise ConversionError("limit")
    remaining = TEXT_BYTES
    for number, page in enumerate(reader.pages, start=1):
        body = _tidy(page.extract_text() or "")
        remaining -= len(body.encode("utf-8"))
        if remaining < 0:
            raise ConversionError("limit")
        if body.strip():
            yield {"locator": f"page:{number}", "text": body}


def convert(kind, data, charset):
    title = ""
    if kind == "pdf":
        segments = list(pdf_pages(data))
        if not segments:
            raise ConversionError("ocr")
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
    if not segments:
        raise ConversionError("empty")
    if len(segments) > MAX_SEGMENTS or sum(len(item["text"].encode("utf-8")) for item in segments) > TEXT_BYTES:
        raise ConversionError("limit")
    return {"sha256": source_digest(data), "title": title, "segments": segments}
