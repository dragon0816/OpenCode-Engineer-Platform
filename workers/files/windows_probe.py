"""Check Windows path components and optionally check for streams or expand DOS short names."""

import ctypes
import os
import sys


SLASH = chr(92)
PREFIX = SLASH * 2 + "?" + SLASH
UNC_PREFIX = PREFIX + "UNC" + SLASH
INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
ERROR_HANDLE_EOF = 38


def namespaced(path):
    return UNC_PREFIX + path[2:] if path.startswith(SLASH * 2) else PREFIX + path


def check_ancestry(path):
    attributes = ctypes.windll.kernel32.GetFileAttributesW
    attributes.argtypes = [ctypes.c_wchar_p]
    attributes.restype = ctypes.c_uint32
    parents = [path]
    while (parent := os.path.dirname(parents[-1])) != parents[-1]:
        parents.append(parent)
    for parent in reversed(parents):
        result = attributes(namespaced(parent))
        if result == INVALID_FILE_ATTRIBUTES or result & FILE_ATTRIBUTE_REPARSE_POINT:
            sys.exit(1)


def check_streams(path):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    first, next_stream, close = kernel.FindFirstStreamW, kernel.FindNextStreamW, kernel.FindClose
    first.argtypes = [ctypes.c_wchar_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    first.restype = ctypes.c_void_p
    next_stream.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    close.argtypes = [ctypes.c_void_p]

    class Stream(ctypes.Structure):
        _fields_ = [("size", ctypes.c_int64), ("name", ctypes.c_wchar * 296)]

    stream = Stream()
    handle = first(namespaced(path), 0, ctypes.byref(stream), 0)
    if handle == ctypes.c_void_p(-1).value:
        if ctypes.get_last_error() != ERROR_HANDLE_EOF:
            sys.exit(1)
        return
    try:
        if (stream.name != "::$DATA" or next_stream(handle, ctypes.byref(stream))
                or ctypes.get_last_error() != ERROR_HANDLE_EOF):
            sys.exit(1)
    finally:
        close(handle)


def expand(path):
    long_name = ctypes.windll.kernel32.GetLongPathNameW
    long_name.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    long_name.restype = ctypes.c_uint32
    buffer = ctypes.create_unicode_buffer(32768)
    if not 0 < long_name(namespaced(path), buffer, len(buffer)) < len(buffer):
        sys.exit(1)
    name = buffer.value
    return SLASH * 2 + name[len(UNC_PREFIX):] if name.startswith(UNC_PREFIX) else name.removeprefix(PREFIX)


if __name__ == "__main__":
    path = sys.argv[1]
    check_ancestry(path)
    mode = sys.argv[2] if len(sys.argv) > 2 else None
    if mode == "plain":
        check_streams(path)
    elif mode == "expand":
        sys.stdout.buffer.write(expand(path).encode("utf-8"))
