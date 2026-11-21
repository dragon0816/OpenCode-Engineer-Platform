"""Parse one bounded synthetic PDF after applying process resource limits."""

import ctypes
import io
import json
import os
import sys
from ctypes import wintypes

MEMORY_LIMIT = 256 * 1024 * 1024
INPUT_LIMIT = 20 * 1024 * 1024


def apply_limits():
    if os.name != "nt":
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
        resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
        return

    class BasicLimits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                    ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t),
                    ("active", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                    ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("io", ctypes.c_ulonglong * 6),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    job = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.basic.flags = 0x2 | 0x8 | 0x100 | 0x2000
    limits.basic.process_time = 20_000_000
    limits.basic.active = 1
    limits.process_memory = MEMORY_LIMIT
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise OSError("PDF job limit setup failed")
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise OSError("PDF job assignment failed")


def main():
    apply_limits()
    from pypdf import PdfReader

    data = sys.stdin.buffer.read(INPUT_LIMIT + 1)
    if not 0 < len(data) <= INPUT_LIMIT:
        raise ValueError("PDF input limit")
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted or not 0 < len(reader.pages) <= 5:
        raise ValueError("PDF pages or encryption")
    text = "\n".join(page.extract_text() for page in reader.pages).strip()
    if len(text) > 4096:
        raise ValueError("PDF output limit")
    print(json.dumps(text or "OCR_REQUIRED"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
