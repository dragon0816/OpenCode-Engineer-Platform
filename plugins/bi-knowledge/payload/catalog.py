# Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/catalog.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
"""Project public schema structure onto OEP's flat review schema."""

import re

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}(/[a-z0-9][a-z0-9._-]{0,39}){0,2}$")
VERSION_RE = re.compile(r"^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(\+[0-9a-f]{12})?$")
TYPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")
FIELD_RE = re.compile(r"^[a-z][a-z0-9_]{0,59}$")


def project(path, document):
    if not isinstance(document, dict):
        return []
    if isinstance(document.get("fields"), list):
        return [{key: document.get(key) for key in ("id", "version", "fields")}]
    schema_id, version, types = (document.get(key) for key in ("schema_id", "version", "types"))
    if not all(isinstance(value, str) for value in (schema_id, version)) or not isinstance(types, list):
        return []
    if not ID_RE.fullmatch(schema_id) or not VERSION_RE.fullmatch(version) or path != f"{schema_id}@{version}.json":
        return []
    result = []
    for entity in types:
        if not isinstance(entity, dict):
            continue
        name, fields = entity.get("name"), entity.get("fields")
        if not isinstance(name, str) or not TYPE_RE.fullmatch(name) or not isinstance(fields, list):
            continue
        names = [field.get("name") if isinstance(field, dict) else None for field in fields]
        if names and all(isinstance(field, str) and FIELD_RE.fullmatch(field) for field in names):
            result.append({"id": f"{schema_id}/{name}", "version": version.replace("+", "-"), "fields": names})
    return result
