import ctypes
import io
import os
from ctypes import wintypes

MEMORY_LIMIT = 256 * 1024 * 1024


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
    limits.basic.process_time = 40_000_000
    limits.basic.active = 1
    limits.process_memory = MEMORY_LIMIT
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise OSError("Extractor job limit setup failed")
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise OSError("Extractor job assignment failed")


def spreadsheet(source):
    apply_limits()
    from xlsx_to_text import project_stream

    return io.BytesIO(project_stream(source))


def pdf_page(source, page):
    apply_limits()
    from pypdf import PdfReader

    reader = PdfReader(source, strict=True)
    if reader.is_encrypted or not 1 <= page <= len(reader.pages):
        raise ValueError("PDF page or encryption")
    text = (reader.pages[page - 1].extract_text() or "").encode("utf-8")
    if len(text) > 1024 * 1024:
        raise ValueError("PDF page projection limit")
    return io.BytesIO(text), len(reader.pages)
