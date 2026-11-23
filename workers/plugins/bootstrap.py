"""Run a verified plugin in the host-created Windows AppContainer."""

import base64
import ctypes
import errno
import json
import os
import runpy
import socket
import sys
from pathlib import Path
from types import ModuleType


def denied(operation):
    try:
        operation()
    except PermissionError:
        return
    except OSError as error:
        if error.errno == errno.EACCES or getattr(error, "winerror", None) == 1314:
            return
        raise
    raise RuntimeError("Isolation probe unexpectedly succeeded")


def probe(port, sentinel):
    def create(path):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        create_file = kernel.CreateFileW
        create_file.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                                ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        create_file.restype = ctypes.c_void_p
        handle = create_file(str(path), 0x40000000, 0, None, 1, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle(handle)

    denied(lambda: Path(sentinel).read_bytes())
    denied(lambda: create(Path(__file__).with_name("write-probe")))
    for variable in ("LOCALAPPDATA", "TEMP", "TMP"):
        root = os.environ.get(variable)
        if root:
            denied(lambda: create(Path(root, "oep-write-probe")))
    for family, hosts in (
        (socket.AF_INET, ("127.0.0.1", "192.0.2.1")),
        (socket.AF_INET6, ("::1", "2001:db8::1")),
    ):
        for host in hosts:
            def connect():
                with socket.socket(family) as client:
                    client.settimeout(1)
                    client.connect((host, port))
            denied(connect)


reader = sys.stdin.buffer
writer = sys.stdout.buffer


def receive():
    line = reader.readline(40 * 1024 * 1024)
    if not line or not line.endswith(b"\n"):
        raise RuntimeError("Missing broker response")
    return json.loads(line)


def send(value):
    writer.write(json.dumps(value, ensure_ascii=True, allow_nan=False).encode("ascii") + b"\n")
    writer.flush()


class BrokerError(Exception):
    """A safe OEP broker error code."""


sequence = 0


def call(method, **params):
    global sequence
    sequence += 1
    send({"jsonrpc": "2.0", "id": sequence, "method": method, "params": params})
    reply = receive()
    if reply.get("id") != sequence:
        raise RuntimeError("Broker response out of order")
    if "error" in reply:
        raise BrokerError(reply["error"]["message"])
    return reply["result"]


def main():
    init = receive()
    probe(init["port"], init["sentinel"])
    send({"ready": True})
    start = receive()
    package = Path(__file__).parent / "package"
    entry = package / start["entry"]
    # Use the isolated standard library first. Packages never shadow bootstrap imports.
    sys.path.extend((str(Path(__file__).parent / "dependencies"), str(package / "vendor"), str(package), str(entry.parent)))
    api = ModuleType("oep_plugin")
    api.call = call
    api.BrokerError = BrokerError
    api.progress = lambda percent: call("progress.emit", percent=percent)
    api.read_source = lambda id: base64.b64decode(call("sources.read", id=id)["base64"])
    api.read_data = lambda path: base64.b64decode(call("data.read", path=path)["base64"])
    api.write_data = lambda path, data: call("data.write", path=path, base64=base64.b64encode(data).decode("ascii"))
    sys.modules[api.__name__] = api
    # Print and tracebacks go to a discarded descriptor, leaving stdout for RPC.
    sys.stdout = sys.stderr
    worker = runpy.run_path(str(entry), run_name="oep_plugin_worker")
    result = worker["run"](start["input"])
    send({"result": result})


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        sys.exit(1)
