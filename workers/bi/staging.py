# Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/staging.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
# Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/store.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
# Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/schema.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
"""Content and entity identities. OEP owns the storage and review transactions."""

import hashlib
import re


def source_digest(data):
    return hashlib.sha256(data).hexdigest()


def norm_key(text):
    return re.sub(r"[\s_\-　()（）:：/／.]", "", str(text)).lower()


def card_id_for(entity_type, canonical_key):
    return hashlib.sha256(f"{entity_type}\0{canonical_key}".encode()).hexdigest()


def card_identity(entity_type, name):
    normalized = norm_key(name)
    return card_id_for(entity_type, normalized) if normalized else ""
