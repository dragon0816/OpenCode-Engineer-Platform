# Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/html_markdown.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
"""Read visible HTML without running it, retaining section anchors for OEP."""

import re
from html.parser import HTMLParser
from urllib.parse import quote

_SKIP = frozenset({
    "script", "style", "noscript", "svg", "template", "head", "nav", "footer",
    "form", "button", "iframe", "select", "textarea", "canvas", "object", "dialog", "aside",
})
_VOID = frozenset({
    "br", "hr", "img", "meta", "link", "input", "source", "area", "base", "col", "wbr", "track",
})
_BLOCKS = frozenset({
    "p", "div", "section", "article", "main", "header", "blockquote", "ul", "ol", "li",
    "table", "tr", "pre", "figure", "figcaption", "dl", "dt", "dd", "address",
    "body", *(f"h{n}" for n in range(1, 7)),
})
_CHARSET_RE = re.compile(rb"<meta[^>]+charset=[\"']?([A-Za-z0-9_-]+)", re.IGNORECASE)


class _Reader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title_parts = []
        self.meta_title = ""
        self.segments = []
        self._line = []
        self._skip = 0
        self._in_title = False
        self._main = 0
        self._anchor = ""
        self._line_anchor = ""
        self.stack = []

    def _flush(self):
        text = re.sub(r"\s+", " ", "".join(self._line)).strip()
        if text:
            self.segments.append((self._main > 0, self._line_anchor, text))
        self._line = []
        self._line_anchor = ""

    def handle_starttag(self, tag, attrs):
        values = {key.lower(): value or "" for key, value in attrs}
        hidden = tag in _SKIP or values.get("aria-hidden") == "true" or "hidden" in values
        main = tag in ("main", "article") or values.get("role") == "main"
        anchor = values.get("id") or (values.get("name", "") if tag == "a" else "")
        if tag == "meta" and values.get("property", "").lower() == "og:title":
            self.meta_title = self.meta_title or values.get("content", "")
        if tag == "title":
            self._in_title = True
        if tag in _VOID:
            if tag in ("br", "hr") and not self._skip:
                self._flush()
            return
        if not self._skip and (tag in _BLOCKS or hidden or main or anchor):
            self._flush()
        self.stack.append((tag, hidden, main, self._anchor))
        self._skip += hidden
        self._main += main
        if self._skip:
            return
        if anchor and len(anchor) <= 120:
            self._anchor = anchor
        if tag in ("td", "th") and self._line:
            self._line.append(" | ")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if not any(opened == tag for opened, *_ in self.stack):
            return
        while self.stack:
            opened, hidden, main, previous = self.stack.pop()
            if not self._skip and (opened in _BLOCKS or main or self._anchor != previous):
                self._flush()
            self._skip -= hidden
            self._main -= main
            self._anchor = previous
            if opened == tag:
                break

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(data)
        elif not self._skip:
            if not self._line_anchor:
                self._line_anchor = self._anchor
            self._line.append(data)

    def close(self):
        super().close()
        self._flush()


def decode(data, declared=""):
    named = _CHARSET_RE.search(data[:4096])
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    for candidate in ("utf-8-sig" if data.startswith(b"\xef\xbb\xbf") else "",
                      named.group(1).decode("ascii") if named else "", declared, "utf-8"):
        if candidate:
            try:
                return data.decode(candidate)
            except (LookupError, UnicodeError):
                continue
    raise UnicodeError("HTML encoding")


def read(data, declared=""):
    reader = _Reader()
    reader.feed(decode(data, declared))
    reader.close()
    title = re.sub(r"\s+", " ", reader.meta_title or "".join(reader.title_parts)).strip()
    use_main = any(main for main, _, _ in reader.segments)
    kept = [(anchor, text) for main, anchor, text in reader.segments if main or not use_main]
    return title[:300], [
        {"locator": f"#{quote(anchor, safe='')}" if anchor else f"paragraph:{number}", "text": text}
        for number, (anchor, text) in enumerate(kept, 1)
    ]
