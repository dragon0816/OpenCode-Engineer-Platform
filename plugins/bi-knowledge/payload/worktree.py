# Ported from dragon0816/agentic-engineering-platform src/knowledge/repo/repository.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
"""Replay portable pushed commits, then the optional exported local working changes."""

import hashlib
import json
import re

SHA256 = re.compile(r"[0-9a-f]{64}\Z")
INPUT_BYTES = 24 * 1024 * 1024
PROJECTION_BYTES = 20 * 1024 * 1024


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def apply(units, key, value):
    if not isinstance(key, str) or not key or len(key) > 300:
        raise ValueError("unit")
    if value is None:
        units.pop(key, None)
    else:
        units[key] = value


def replay(repository, commits, local, pending):
    ordered = []
    for author, seq, raw in commits:
        row = json.loads(raw)
        commit = row.pop("id", None)
        if (row.get("format") != "aep.knowledge.commit/v1" or row.get("repo") != repository
                or row.get("author") != author or row.get("seq") != seq or type(row.get("clock")) is not int
                or not 1 <= row["clock"] < 2**53 or commit != digest(row)):
            raise ValueError("commit")
        ordered.append((row["clock"], author, seq, commit, row["ops"]))
    ordered.sort(key=lambda record: record[:3])
    units = {}
    conflicts = 0
    for _, _, _, _, ops in ordered:
        for op in ops:
            key, value, base = op["unit"], op["value"], op["base"]
            if base is not None and (not isinstance(base, str) or not SHA256.fullmatch(base)):
                raise ValueError("base")
            current = units.get(key)
            if base != (None if current is None else digest(current)) and canonical(current) != canonical(value):
                conflicts += 1
                continue
            apply(units, key, value)
    for _, raw in sorted(local):
        for op in json.loads(raw)["ops"]:
            apply(units, op["unit"], op["value"])
    if pending is not None:
        for key, value in json.loads(pending).get("sets", {}).items():
            apply(units, key, value)
    # These are data units. Imported skills and tools never become runnable host code.
    roots = ("card:", "field:", "state:", "relation:", "evidence:", "relation_evidence:")
    projected = {key: value for key, value in units.items() if key == "schema" or key.startswith(roots)}
    # The broker serializes the returned JSON as ASCII, including escaped non-ASCII text.
    if len(json.dumps(projected, ensure_ascii=True, allow_nan=False)) > PROJECTION_BYTES:
        raise ValueError("limit")
    return {"units": projected, "digest": digest(units), "conflicts": conflicts, "commits": len(ordered),
            "clock": ordered[-1][0] if ordered else 0}
