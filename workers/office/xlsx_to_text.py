"""Project an ordinary XLSX workbook to bounded, sheet-labelled CSV."""

import csv
import io
import math
import posixpath
import re
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile

MIB = 1024 * 1024
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


class NoDtd(ET.TreeBuilder):
    def doctype(self, *_):
        raise ValueError("DTD is unsupported")


def read_xml(archive, name):
    with archive.open(name) as stream:
        entry = archive.getinfo(name)
        data = stream.read(entry.file_size + 1)
    if len(data) != entry.file_size:
        raise ValueError("invalid ZIP entry")
    return ET.fromstring(data, parser=ET.XMLParser(target=NoDtd()))


def validate_archive(archive):
    entries = archive.infolist()
    if len(entries) > 512 or sum(entry.file_size for entry in entries) > 100 * MIB:
        raise ValueError("archive expansion limit")
    names = {entry.filename for entry in entries}
    if len(names) != len(entries):
        raise ValueError("duplicate ZIP entry")
    for entry in entries:
        name = entry.filename
        if (entry.flag_bits & 1 or re.search(r"[\\:%?#\x00-\x1f]", name)
                or set(name.rstrip("/").split("/")) & {"", ".", ".."}
                or re.search(r"(^|/)(externalLinks|embeddings|activeX|vbaProject[^/]*)(/|$)", name, re.I)):
            raise ValueError("unsupported ZIP entry")
        if name.endswith(".rels"):
            for link in read_xml(archive, name):
                if link.get("TargetMode", "Internal") != "Internal":
                    raise ValueError("external relationships are unsupported")
    manifest = read_xml(archive, "[Content_Types].xml")
    if not any(item.get("PartName") == "/xl/workbook.xml" and item.get("ContentType") ==
               "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" for item in manifest):
        raise ValueError("unsupported workbook type")
    return names


def cell_value(cell, shared):
    if cell.find(NS + "f") is not None:
        return "[formula omitted]"
    kind = cell.get("t", "n")
    value = cell.findtext(NS + "v", "")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(f".//{NS}t"))
    if kind == "s":
        index = int(value)
        if not 0 <= index < len(shared):
            raise ValueError("shared string index")
        return shared[index]
    if kind == "b":
        if value not in {"0", "1"}:
            raise ValueError("invalid boolean")
        return "TRUE" if value == "1" else "FALSE"
    if kind == "n" and value and not math.isfinite(float(value)):
        raise ValueError("invalid number")
    if kind not in {"n", "str", "e", "d"}:
        raise ValueError("unsupported cell type")
    return value


def project(content):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
    with ZipFile(io.BytesIO(content)) as archive:
        names = validate_archive(archive)
        shared = []
        if "xl/sharedStrings.xml" in names:
            shared = ["".join(node.text or "" for node in item.findall(f".//{NS}t"))
                      for item in read_xml(archive, "xl/sharedStrings.xml").findall(NS + "si")]
        book = read_xml(archive, "xl/workbook.xml")
        sheets = book.findall(f"{NS}sheets/{NS}sheet")
        if not 0 < len(sheets) <= 10:
            raise ValueError("worksheet count limit")
        links = {}
        for link in read_xml(archive, "xl/_rels/workbook.xml.rels").findall(REL + "Relationship"):
            if link.get("Type") != DOC + "/worksheet":
                continue
            target = link.attrib["Target"]
            if set(target.lstrip("/").split("/")) & {"", ".", ".."}:
                raise ValueError("invalid worksheet target")
            name = target[1:] if target.startswith("/") else posixpath.join("xl", target)
            if not re.fullmatch(r"xl/worksheets/[A-Za-z0-9_.-]+\.xml", name) or link.attrib["Id"] in links:
                raise ValueError("invalid worksheet relationship")
            links[link.attrib["Id"]] = name
        seen = set()
        for sheet in sheets:
            title = sheet.attrib["name"]
            target = links[sheet.attrib[f"{{{DOC}}}id"]]
            if not title or title in seen or target in seen:
                raise ValueError("duplicate worksheet")
            seen.update((title, target))
            worksheet = read_xml(archive, target)
            data = worksheet.findall(NS + "sheetData")
            if worksheet.tag != NS + "worksheet" or len(data) != 1:
                raise ValueError("invalid worksheet")
            writer.writerow(["Sheet", title])
            previous = 0
            for row in data[0]:
                index = int(row.attrib["r"])
                if row.tag != NS + "row" or not previous < index <= 500:
                    raise ValueError("row limit or ordering")
                previous = index
                values = []
                for cell in row:
                    coordinate = re.fullmatch(r"([A-Z]{1,2})([1-9][0-9]{0,2})", cell.get("r", ""))
                    if cell.tag != NS + "c" or coordinate is None or int(coordinate[2]) != index:
                        raise ValueError("invalid cell coordinate")
                    column = 0
                    for letter in coordinate[1]:
                        column = column * 26 + ord(letter) - ord("A") + 1
                    if not len(values) < column <= 50:
                        raise ValueError("column limit or ordering")
                    values.extend([""] * (column - len(values) - 1))
                    values.append(cell_value(cell, shared))
                writer.writerow([f"Row {index}", *values])
                if output.tell() > MIB:
                    raise ValueError("CSV projection limit")
            writer.writerow([])
    data = output.getvalue().encode("utf-8", errors="strict")
    if len(data) > MIB:
        raise ValueError("CSV projection limit")
    return data


if __name__ == "__main__":
    try:
        source = sys.stdin.buffer.read(20 * MIB + 1)
        if len(source) > 20 * MIB:
            raise ValueError("upload limit")
        sys.stdout.buffer.write(project(source))
    except Exception:
        sys.stderr.write("Unsupported XLSX or workbook conversion limit exceeded.\n")
        sys.exit(1)
