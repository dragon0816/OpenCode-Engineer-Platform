"""Read an owner-approved location through pinned, read-only Windows handles."""

import codecs
import ctypes as c
from ctypes import wintypes as w
from contextlib import ExitStack, contextmanager
import hashlib
import heapq
import json
import msvcrt
import ntpath
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from windows_write import (
    READ_ATTRIBUTES, TRAVERSE, api, check, child, close_handle, create_file,
    inode, verify, win,
)

MAX_CHUNK = 16 * 1024
FULL_HASH_LIMIT = 16 * 1024 * 1024
DRIVE = re.compile(r"[a-z]:\\", re.I)
SPECIAL = re.compile(
    r"^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)"
    r"|[~][0-9]+(?:\.|$)|[<>:\"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", re.I)
CREDENTIAL = re.compile(
    r"^(?:\.(?:git|ssh|aws|azure|gnupg|kube|docker|config|codex|claude|env|netrc|npmrc|pypirc|mcp)(?:\.|$)"
    r"|\.(?:git-credentials|pgpass|vault-token|terraform\.d)$"
    r"|(?:credentials|secrets|login data|local state|ntuser|id_rsa|id_ed25519)(?:[. -]|$))"
    r"|\.(?:pem|pfx|p12|key|kdbx)$", re.I)

get_drive_type = api(win, "GetDriveTypeW", w.UINT, w.LPCWSTR)
get_attributes = api(win, "GetFileAttributesW", w.DWORD, w.LPCWSTR)
get_info = api(win, "GetFileInformationByHandleEx", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
duplicate = api(win, "DuplicateHandle", w.BOOL, w.HANDLE, w.HANDLE, w.HANDLE,
                c.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD)
current_process = api(win, "GetCurrentProcess", w.HANDLE)


class BasicInfo(c.Structure):
    _fields_ = [("creation", c.c_longlong), ("access", c.c_longlong),
                ("modified", c.c_longlong), ("changed", c.c_longlong), ("attributes", w.DWORD)]


def valid_part(part):
    return bool(part and not part.endswith((" ", ".")) and not SPECIAL.search(part) and not CREDENTIAL.search(part))


def parts(path):
    drive, tail = ntpath.splitdrive(path)
    root = drive + "\\"
    names = tail[1:].split("\\")
    if (not DRIVE.fullmatch(root) or not tail.startswith("\\") or not all(map(valid_part, names))
            or names[0].lower() in {"system volume information", "$recycle.bin", "recovery", "boot", "config.msi",
                                    "bootmgr", "hiberfil.sys", "pagefile.sys", "swapfile.sys"}):
        raise ValueError("Invalid location")
    return root, names


def overlaps(left, right):
    left, right = (ntpath.normcase(value).rstrip("\\") for value in (left, right))
    return left == right or left.startswith(right + "\\") or right.startswith(left + "\\")


@contextmanager
def pin(path, protected, directory=None):
    root, names = parts(path)
    if any(overlaps(path, restricted) for restricted in protected) or get_drive_type(root) not in (2, 3):
        raise PermissionError("Protected location")
    with ExitStack() as stack:
        handle = create_file(root, READ_ATTRIBUTES | TRAVERSE, 3, None, 3, 0x2200000, None)
        check(handle != c.c_void_p(-1).value)
        stack.callback(close_handle, handle)
        verify(handle, root, True)
        location = root
        for name in names[:-1]:
            handle = stack.enter_context(child(handle, name, True))
            location = ntpath.join(location, name)
            verify(handle, location, True)
        if directory is None:
            attributes = get_attributes("\\\\?\\" + path)
            check(attributes != 0xffffffff and not attributes & 0x400)
            directory = bool(attributes & 0x10)
        opened = stack.enter_context(child(handle, names[-1], directory, read=True))
        yield opened, directory


def metadata(handle, path, directory):
    info = verify(handle, path, directory)
    basic = BasicInfo()
    check(get_info(handle, 0, c.byref(basic), c.sizeof(basic)))
    value = {"key": [str(info.volume), str(inode(info)), str(basic.creation)]}
    if not directory:
        value.update(size=(info.size_hi << 32 | info.size_lo),
                     modified=str(basic.modified), changed=str(basic.changed))
    return value


def open_stream(handle):
    process = current_process()
    copy = w.HANDLE()
    check(duplicate(process, handle, process, c.byref(copy), 0, False, 2))
    try:
        fd = msvcrt.open_osfhandle(copy.value, os.O_RDONLY | os.O_BINARY)
    except OSError:
        close_handle(copy)
        raise
    return os.fdopen(fd, "rb")


def identify(handle, path, directory):
    value = metadata(handle, path, directory)
    if not directory and value["size"] <= FULL_HASH_LIMIT:
        with open_stream(handle) as source:
            source.seek(0)
            value["sha256"] = hashlib.file_digest(source, "sha256").hexdigest()
    return value


def listing(path, protected, cursor):
    def readable(entry):
        if not valid_part(entry.name) or any(overlaps(ntpath.join(path, entry.name), root) for root in protected):
            return False
        try:
            stat = entry.stat(follow_symlinks=False)
            return not stat.st_file_attributes & 0x400 and (entry.is_dir() or entry.is_file())
        except OSError:
            return False

    with os.scandir("\\\\?\\" + path) as entries:
        page = heapq.nsmallest(33, (entry for entry in entries if entry.name > cursor and readable(entry)),
                               key=lambda entry: entry.name)
        return {"entries": [{"name": entry.name, "kind": "folder" if entry.is_dir() else "file"} for entry in page[:32]],
                "next": page[31].name if len(page) > 32 else None}


def extract(source, request):
    offset, length = request["offset"], request["length"]
    mode = request["mode"]
    if not 0 <= offset <= 2**53-1 or not 1 <= length <= MAX_CHUNK:
        raise ValueError("Invalid range")
    source.seek(0)
    page_count = None
    if mode in ("xlsx", "pdf"):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "office"))
        from reference_extractors import spreadsheet, pdf_page
        if mode == "xlsx":
            source = spreadsheet(source)
        else:
            source, page_count = pdf_page(source, request["page"])
    elif mode not in ("text", "csv", "json"):
        return {"error": "reference-format"}
    total = source.seek(0, os.SEEK_END)
    if offset > total:
        return {"error": "reference-range"}
    source.seek(offset)
    chunk = source.read(length)
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    text = decoder.decode(chunk, final=offset + len(chunk) == total)
    pending = decoder.getstate()[0]
    if pending and len(pending) == len(chunk):
        # Allow even a one-byte request to advance over a UTF-8 sequence.
        chunk += source.read(4 - len(chunk))
        decoder.reset()
        text = decoder.decode(chunk, final=offset + len(chunk) == total)
        pending = decoder.getstate()[0]
    consumed = len(chunk) - len(pending)
    return {"text": text, "offset": offset, "next": offset + consumed if offset + consumed < total else None,
            "bytes": total, "mode": mode, "chunkSha256": hashlib.sha256(chunk[:consumed]).hexdigest(),
            **({"page": request["page"], "pages": page_count} if page_count is not None else {})}


def run(request):
    path, protected = request["path"], request["protected"]
    action, expected = request["action"], request.get("expected")
    with pin(path, protected, request.get("directory")) as (handle, directory):
        identity = identify(handle, path, directory)
        if expected is not None and identity != expected:
            return {"error": "reference-changed"}
        if action == "inspect":
            if metadata(handle, path, directory) != {k: v for k, v in identity.items() if k != "sha256"}:
                return {"error": "reference-changed"}
            return {"identity": identity, "directory": directory}
        target = request.get("child", "")
        with ExitStack() as stack:
            opened, location, is_dir = handle, path, directory
            if target:
                if not directory or not all(map(valid_part, target.split("/"))):
                    raise ValueError("Invalid relative path")
                location = ntpath.join(path, *target.split("/"))
                opened, is_dir = stack.enter_context(pin(location, protected, action == "list"))
            if is_dir != (action == "list"):
                return {"error": "reference-format"}
            member = identify(opened, location, is_dir) if target else identity
            if request.get("member") is not None and member != request["member"]:
                return {"error": "reference-changed"}
            if action == "list":
                result = listing(location, protected, request["cursor"])
            else:
                try:
                    with open_stream(opened) as source:
                        result = extract(source, request)
                except Exception:
                    return {"error": "reference-extraction"}
            if metadata(opened, location, is_dir) != {k: v for k, v in member.items() if k != "sha256"}:
                return {"error": "reference-changed"}
            return {"result": result, "member": member}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin.buffer)
        try:
            result = run(request)
        except (OSError, ValueError):
            result = {"error": "reference-changed" if request.get("expected") and
                      (not request.get("child") or request.get("member")) else "reference-unavailable"}
        print(json.dumps(result, ensure_ascii=True))
    except Exception:
        sys.exit(1)
