# Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/recipes.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
"""Project a labelled source record to field values and their original evidence.

OEP's text recipe uses key/value lines as columns and a converted block as a row.
Like the AEP rule path, the mapping is explicit and a blank cell yields no value.
"""

import re


def records(chunk, fields, labels):
    candidates = []
    name_label = labels.get("name", "name").casefold()
    for part in chunk:
        cells = {}
        for line in part["text"].splitlines():
            cell = re.fullmatch(r"\s*([^:：]+)[:：]\s*(.+?)\s*", line)
            if cell:
                label, value = cell.groups()
                cells.setdefault(label.strip().casefold(), (value, line.strip()))
        if name_label not in cells:
            continue
        candidate = {"name": cells[name_label][0], "fields": {}}
        for field in fields:
            found = cells.get(labels.get(field, field).casefold())
            if found:
                value, quote = found
                candidate["fields"][field] = {"value": value, "quote": quote, "segment": part["id"]}
        candidates.append(candidate)
    return candidates
