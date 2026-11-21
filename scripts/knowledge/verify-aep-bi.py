"""Check a published BI exchange file using its Python JSON number encoding."""

import hashlib
import json
import sys


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate JSON key")
    return result


def invalid_number(_):
    raise ValueError("invalid JSON number")


def digest(document, *, pretty=False):
    text = json.dumps(document, ensure_ascii=False, sort_keys=True, allow_nan=False,
                      indent=1 if pretty else None, separators=None if pretty else (",", ":"))
    return hashlib.sha256((text + ("\n" if pretty else "")).encode("utf-8")).hexdigest()


try:
    snapshot = json.load(sys.stdin.buffer, object_pairs_hook=unique_object, parse_constant=invalid_number)
    assert snapshot["format"] == "aep-bi-dataset-snapshot/1"
    assert isinstance(snapshot["publication"], dict)
    assert digest({key: value for key, value in snapshot.items() if key not in ("digest", "publication")}) == snapshot["digest"]
    assert digest(snapshot["schema"]["document"], pretty=True) == snapshot["schema"]["sha256"]
except (AssertionError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
    sys.exit(1)
