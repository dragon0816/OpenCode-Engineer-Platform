"""Compatibility entry point for the interim BI document panel."""

import base64
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
sys.path[:0] = [str(root.parents[1] / "plugins" / "bi-knowledge" / "payload"),
                str(root.parent / "office"), str(root.parent / "plugins")]

from bootstrap import call, receive, send
from document import process
from reference_extractors import apply_limits


if __name__ == "__main__":
    apply_limits()
    request = receive()
    payload = process(sys.argv[1], sys.argv[2:], base64.b64decode(request["base64"]), call)
    send({"result": payload})
