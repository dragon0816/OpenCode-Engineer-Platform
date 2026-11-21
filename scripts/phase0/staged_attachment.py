"""Read bounded bytes from the exact file handle verified inside staging."""

import ctypes
import os
import re
import stat
from ctypes import wintypes

MAX_FILE = 20 * 1024 * 1024


def windows_open(path):
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x00200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise OSError("staged file open failed")
    try:
        attrs = (wintypes.DWORD * 2)()
        if not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(attrs), ctypes.sizeof(attrs)) or attrs[0] & (0x10 | 0x400):
            raise ValueError("staged file reparse point or directory")
        final = ctypes.create_unicode_buffer(32768)
        length = kernel.GetFinalPathNameByHandleW(handle, final, len(final), 0)
        if not 0 < length < len(final) or os.path.normcase(final.value.removeprefix('\\\\?\\')) != os.path.normcase(str(path)):
            raise ValueError("staged handle outside its expected path")
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        return fd
    finally:
        if handle is not None:
            kernel.CloseHandle(handle)


def staged_bytes(root, name):
    if not re.fullmatch(r'[a-z][a-z0-9_-]*\.(?:pdf|png|xlsx)', name):
        raise ValueError("invalid staged name")
    if os.name == 'nt':
        fd = windows_open(root / name)
    else:
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally:
            os.close(parent)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= MAX_FILE:
            raise ValueError("invalid staged file identity or size")
        content = handle.read(MAX_FILE + 1)
        if len(content) != info.st_size:
            raise ValueError("staged file size changed")
        return content
