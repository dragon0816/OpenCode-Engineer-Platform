"""OEP worker entry point. No model, network or workspace access."""

import json
import sys
from pathlib import Path

# Isolated Python removes the script directory from its import search path.
root = Path(__file__).resolve().parent
sys.path[:0] = [str(root), str(root.parent / "office")]
from reference_extractors import apply_limits


def main():
    apply_limits()
    from catalog import project
    from convert import SOURCE_BYTES, ConversionError, convert
    from extract import plan
    from staging import card_identity

    operation = sys.argv[1]
    data = sys.stdin.buffer.read(SOURCE_BYTES + 1)
    try:
        if len(data) > SOURCE_BYTES:
            raise ConversionError("limit")
        if operation == "convert":
            result = convert(sys.argv[2], data, sys.argv[3])
        elif operation == "plan":
            result = plan(json.loads(data))
        elif operation == "schema":
            result = [schema for path, document in json.loads(data) for schema in project(path, document)]
        elif operation == "identities":
            result = [card_identity(entity_type, name) for entity_type, name in json.loads(data)]
        else:
            raise ValueError("format")
        payload = {"result": result}
    except ConversionError as error:
        payload = {"error": str(error)}
    except UnicodeError:
        payload = {"error": "encoding"}
    except ValueError as error:
        payload = {"error": "limit" if str(error) == "limit" else "invalid"}
    except Exception:
        payload = {"error": "invalid"}
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii"))


if __name__ == "__main__":
    main()
