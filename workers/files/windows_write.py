"""Publish one file within a pinned Windows directory. Input bytes arrive on stdin."""

import ctypes as c
from ctypes import wintypes as w
from contextlib import ExitStack, contextmanager
import hashlib
import json
import ntpath
import re
import sys
import uuid


class FileInfo(c.Structure):
    _fields_ = [
        ("attributes", w.DWORD), ("created", w.FILETIME), ("accessed", w.FILETIME),
        ("modified", w.FILETIME), ("volume", w.DWORD), ("size_hi", w.DWORD),
        ("size_lo", w.DWORD), ("links", w.DWORD), ("index_hi", w.DWORD), ("index_lo", w.DWORD),
    ]


class UnicodeString(c.Structure):
    _fields_ = [("length", w.USHORT), ("capacity", w.USHORT), ("buffer", w.LPWSTR)]


class ObjectAttributes(c.Structure):
    _fields_ = [
        ("length", w.ULONG), ("parent", w.HANDLE), ("name", c.POINTER(UnicodeString)),
        ("attributes", w.ULONG), ("security", c.c_void_p), ("quality", c.c_void_p),
    ]


class IoStatus(c.Structure):
    _fields_ = [("status", c.c_void_p), ("information", c.c_size_t)]


class RenameInfo(c.Structure):
    _fields_ = [("flags", w.DWORD), ("parent", w.HANDLE), ("length", w.DWORD), ("name", w.WCHAR)]


win = c.WinDLL("kernel32", use_last_error=True)
nt = c.WinDLL("ntdll")


def api(library, name, result, *args):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = args
    return function


create_file = api(win, "CreateFileW", w.HANDLE, w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE)
close_handle = api(win, "CloseHandle", w.BOOL, w.HANDLE)
final_name = api(win, "GetFinalPathNameByHandleW", w.DWORD, w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD)
file_info = api(win, "GetFileInformationByHandle", w.BOOL, w.HANDLE, c.POINTER(FileInfo))
set_info = api(win, "SetFileInformationByHandle", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
write_file = api(win, "WriteFile", w.BOOL, w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p)
flush = api(win, "FlushFileBuffers", w.BOOL, w.HANDLE)
open_child = api(nt, "NtCreateFile", w.LONG, c.POINTER(w.HANDLE), w.ULONG, c.POINTER(ObjectAttributes),
                 c.POINTER(IoStatus), c.c_void_p, w.ULONG, w.ULONG, w.ULONG, w.ULONG, c.c_void_p, w.ULONG)
query_info = api(nt, "NtQueryInformationFile", w.LONG, w.HANDLE, c.POINTER(IoStatus), c.c_void_p, w.ULONG, w.ULONG)
set_native_info = api(nt, "NtSetInformationFile", w.LONG, w.HANDLE, c.POINTER(IoStatus), c.c_void_p, w.ULONG, w.ULONG)
status_error = api(nt, "RtlNtStatusToDosError", w.ULONG, w.LONG)

READ_ATTRIBUTES = 0x80
TRAVERSE = 0x20
SYNCHRONIZE = 0x100000
DIRECTORY = 0x10
REPARSE = 0x400
MAX_BYTES = 256 * 1024
MAX_COPY_BYTES = 20 * 1024 * 1024


def check(ok):
    if not ok:
        raise c.WinError(c.get_last_error())


@contextmanager
def child(parent, name, directory, create=False, read=False):
    buffer = c.create_unicode_buffer(name)
    length = len(name.encode("utf-16-le"))
    text = UnicodeString(length, length + 2, c.cast(buffer, w.LPWSTR))
    # OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE. Each open resolves a single component.
    attributes = ObjectAttributes(c.sizeof(ObjectAttributes), parent, c.pointer(text), 0x1040)
    handle = w.HANDLE()
    access = READ_ATTRIBUTES | SYNCHRONIZE | (TRAVERSE if directory else 1 if read else 0x10002)
    # FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | directory/non-directory.
    options = 0x200020 | (1 if directory else 0x40)
    # Deny delete sharing on ancestors. Exclusive sharing on the staging file.
    status = open_child(c.byref(handle), access, c.byref(attributes), c.byref(IoStatus()), None,
                        0, 3 if directory else 1 if read else 0, 2 if create else 1, options, None, 0)
    if status < 0:
        raise c.WinError(status_error(status))
    try:
        yield handle
    finally:
        close_handle(handle)


def verify(handle, path, directory, exact=False):
    info = FileInfo()
    check(file_info(handle, c.byref(info)))
    if info.attributes & REPARSE or bool(info.attributes & DIRECTORY) != directory or not directory and info.links != 1:
        raise ValueError("Unsafe file type")
    buffer = c.create_unicode_buffer(32768)
    length = final_name(handle, buffer, len(buffer), 0)
    check(0 < length < len(buffer))
    name = buffer.value
    expected = "\\\\?\\" + path
    if name.casefold() != expected.casefold() or exact and ntpath.basename(name) != ntpath.basename(expected):
        raise ValueError("Unexpected file name")
    return info


def rename(handle, parent, name):
    encoded = name.encode("utf-16-le")
    size = RenameInfo.name.offset + len(encoded) + 2
    buffer = c.create_string_buffer(max(c.sizeof(RenameInfo), size))
    info = RenameInfo.from_buffer(buffer)
    info.parent = parent
    info.length = len(encoded)
    # ReplaceIfExists is false. The destination is resolved relative to the pinned directory.
    c.memmove(c.addressof(buffer) + RenameInfo.name.offset, encoded, len(encoded))
    status = set_native_info(handle, c.byref(IoStatus()), buffer, len(buffer), 10)  # FileRenameInformation
    if status < 0:
        raise c.WinError(status_error(status))


def valid_name(name):
    return re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,119}", name) and not name.endswith(".") and not re.match(
        r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", name
    ) and not name.startswith("staging-")


def inode(info):
    return info.index_hi << 32 | info.index_lo


@contextmanager
def pinned(root, expected_inode):
    drive, relative = ntpath.splitdrive(root)
    parts = relative.removeprefix("\\").split("\\")
    if not re.fullmatch(r"[A-Za-z]:", drive) or not relative.startswith("\\") or any(
        not part or part in (".", "..") or any(char in part for char in "/:~") or part.endswith((" ", ".")) for part in parts
    ):
        raise ValueError("Invalid root")
    path = drive + "\\"
    with ExitStack() as stack:
        handle = create_file(path, READ_ATTRIBUTES | TRAVERSE, 3, None, 3, 0x2200000, None)
        check(handle != c.c_void_p(-1).value)
        stack.callback(close_handle, handle)
        verify(handle, path, True)
        for part in parts:
            handle = stack.enter_context(child(handle, part, True))
            path = ntpath.join(path, part)
            parent_info = verify(handle, path, True)
        if inode(parent_info) != expected_inode:
            raise ValueError("Output directory changed")
        flags = w.ULONG()
        # FileCaseSensitiveInformation. Require case-insensitive collision checks in the kernel.
        if query_info(handle, c.byref(IoStatus()), c.byref(flags), c.sizeof(flags), 71) != 0 or flags.value:
            raise ValueError("Unsupported directory naming")
        yield handle


def prepare(root, name, expected_inode):
    if not valid_name(name):
        raise ValueError("Invalid output directory")
    with pinned(root, expected_inode) as handle, child(handle, name, True, create=True) as directory:
        return {"inode": str(inode(verify(directory, ntpath.join(root, name), True, exact=True)))}


def publish(root, name, content, expected_inode, before_rename=None, maximum=MAX_BYTES):
    if not valid_name(name) or len(content) > maximum:
        raise ValueError("Invalid output")
    with pinned(root, expected_inode) as handle:
        temporary = "staging-" + uuid.uuid4().hex + ".tmp"
        with child(handle, temporary, False, create=True) as file:
            published = False
            try:
                verify(file, ntpath.join(root, temporary), False, exact=True)
                count = w.DWORD()
                check(write_file(file, content, len(content), c.byref(count), None))
                if count.value != len(content):
                    raise ValueError("Incomplete write")
                check(flush(file))
                if before_rename:
                    before_rename()
                rename(file, handle, name)
                info = verify(file, ntpath.join(root, name), False, exact=True)
                published = True
                return {"inode": str(inode(info)), "sha256": hashlib.sha256(content).hexdigest()}
            finally:
                if not published:
                    set_info(file, 4, c.byref(w.BOOL(True)), c.sizeof(w.BOOL))


if __name__ == "__main__":
    try:
        operation, location, filename, expected = sys.argv[1:]
        if operation in ("write", "copy"):
            maximum = MAX_COPY_BYTES if operation == "copy" else MAX_BYTES
            result = publish(location, filename, sys.stdin.buffer.read(maximum + 1), int(expected), maximum=maximum)
        elif operation == "mkdir":
            result = prepare(location, filename, int(expected))
        else:
            raise ValueError("Unsupported operation")
        print(json.dumps(result))
    except (OSError, ValueError):
        sys.exit(1)
