"""Compatibility entry point for the interim BI document panel."""

import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
sys.path[:0] = [str(root.parents[1] / "plugins" / "bi-knowledge" / "payload"), str(root.parent / "office")]

from convert import SOURCE_BYTES
from document import process
from reference_extractors import apply_limits


if __name__ == "__main__":
    apply_limits()
    payload = process(sys.argv[1], sys.argv[2:], sys.stdin.buffer.read(SOURCE_BYTES + 1))
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii"))
