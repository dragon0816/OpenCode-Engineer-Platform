"""Verify the limited XLSX relationship graph before openpyxl reads it."""

import io
import posixpath
import re
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring

PART_LIMIT = 512 * 1024
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PACKAGE = "application/vnd.openxmlformats-package."
DOCUMENT = "application/vnd.openxmlformats-officedocument."
TYPES = {
    DOC_REL + "officeDocument": DOCUMENT + "spreadsheetml.sheet.main+xml",
    DOC_REL + "worksheet": DOCUMENT + "spreadsheetml.worksheet+xml",
    DOC_REL + "styles": DOCUMENT + "spreadsheetml.styles+xml",
    DOC_REL + "sharedStrings": DOCUMENT + "spreadsheetml.sharedStrings+xml",
    DOC_REL + "theme": DOCUMENT + "theme+xml",
    DOC_REL + "extended-properties": DOCUMENT + "extended-properties+xml",
    REL_NS + "/metadata/core-properties": PACKAGE + "core-properties+xml",
}


def read_parts(content):
    with ZipFile(io.BytesIO(content)) as archive:
        members = archive.infolist()
        if len(members) > 100 or len({item.filename for item in members}) != len(members):
            raise ValueError("archive entry count or duplication")
        total = 0
        parts = {}
        for member in members:
            name = member.filename
            if (member.file_size > PART_LIMIT or member.flag_bits & 1 or not name or
                    re.search(r"[\\:%?#\x00-\x1f]", name) or any(piece in {"", ".", ".."} for piece in name.split("/"))):
                raise ValueError("unsupported archive member")
            with archive.open(member) as stream:
                data = stream.read(PART_LIMIT + 1)
            total += len(data)
            if len(data) != member.file_size or len(data) > PART_LIMIT or total > 4 * 1024 * 1024:
                raise ValueError("inflated size")
            parts[name] = data
    return parts


def validate_workbook(content):
    parts = read_parts(content)
    manifest = '[Content_Types].xml'

    def parse(name):
        return fromstring(parts[name], forbid_dtd=True, forbid_entities=True, forbid_external=True)

    types = parse(manifest)
    if types.tag != f'{{{CT_NS}}}Types':
        raise ValueError("invalid manifest")
    overrides = {}
    defaults = {}
    for item in types:
        kind = item.attrib.get('ContentType')
        if item.tag == f'{{{CT_NS}}}Override':
            name = item.attrib['PartName']
            if not name.startswith('/') or name[1:] not in parts or name[1:] in overrides or kind not in TYPES.values():
                raise ValueError("unsupported manifest override")
            overrides[name[1:]] = kind
        elif item.tag == f'{{{CT_NS}}}Default':
            ext = item.attrib['Extension']
            if ext in defaults or (ext, kind) not in {('rels', PACKAGE + 'relationships+xml'), ('xml', 'application/xml')}:
                raise ValueError("unsupported manifest default")
            defaults[ext] = kind
        else:
            raise ValueError("unknown manifest item")

    visited = {manifest}
    documents = {}

    def relationships(source):
        directory, basename = posixpath.split(source)
        rels = posixpath.join(directory, '_rels', basename + '.rels')
        if rels not in parts:
            return {}
        visited.add(rels)
        root = parse(rels)
        if root.tag != f'{{{REL_NS}}}Relationships':
            raise ValueError("invalid relationships")
        linked = {}
        for item in root:
            rel_id, kind, target = (item.attrib[field] for field in ('Id', 'Type', 'Target'))
            if (item.tag != f'{{{REL_NS}}}Relationship' or rel_id in linked or kind not in TYPES or
                    item.attrib.get('TargetMode', 'Internal') != 'Internal' or re.search(r"[\\:%?#\x00-\x1f]", target) or
                    any(piece in {"", ".", ".."} for piece in target.removeprefix('/').split('/'))):
                raise ValueError("unsupported relationship")
            name = target[1:] if target.startswith('/') else posixpath.join(directory, target)
            if name not in parts or overrides.get(name) != TYPES[kind] or name in documents:
                raise ValueError("unbound part or duplicate target")
            linked[rel_id] = (kind, name)
            documents[name] = parse(name)
            visited.add(name)
            children = relationships(name)
            if kind == DOC_REL + 'officeDocument':
                validate_sheets(documents[name], children, documents)
            elif children:
                raise ValueError("unsupported nested parts")
        return linked

    root_links = relationships('')
    if sum(kind == DOC_REL + 'officeDocument' for kind, _ in root_links.values()) != 1 or visited != parts.keys():
        raise ValueError("missing workbook or orphaned parts")


def validate_sheets(workbook, links, documents):
    prefix = f'{{{SHEET_NS}}}'
    declared = workbook.findall(f'{prefix}sheets/{prefix}sheet')
    sheets = {rel_id: name for rel_id, (kind, name) in links.items() if kind == DOC_REL + 'worksheet'}
    ids = [sheet.attrib.get(f'{{{DOC_REL[:-1]}}}id') for sheet in declared]
    if not 0 < len(ids) <= 4 or len(set(ids)) != len(ids) or set(ids) != sheets.keys():
        raise ValueError("worksheet graph mismatch")
    for name in sheets.values():
        worksheet = documents[name]
        rows = worksheet.findall(f'{prefix}sheetData/{prefix}row')
        if worksheet.tag != f'{prefix}worksheet' or len(rows) > 200:
            raise ValueError("invalid worksheet or row limit")
        for row in rows:
            if not 1 <= int(row.attrib.get('r', '0')) <= 200:
                raise ValueError("row limit")
            cells = row.findall(f'{prefix}c')
            if len(cells) > 24:
                raise ValueError("column limit")
            for cell in cells:
                locator = re.fullmatch(r'[A-X]([1-9][0-9]{0,2})', cell.attrib.get('r', ''))
                if not locator or not 1 <= int(locator[1]) <= 200:
                    raise ValueError("cell locator limit")
