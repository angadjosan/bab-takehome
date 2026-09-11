"""JSON Pointer (RFC 6901) lookup and update for manifest and lockfile documents.

A pointer is "" (the whole document) or a sequence of reference tokens, each preceded by "/". In a
token, "~1" encodes "/" and "~0" encodes "~" (RFC 6901, sections 3 and 4). Any other use of "~" is
an error. escape(key) turns an object key into a token and parse(pointer) returns the decoded
tokens, so parse(to_pointer(keys)) == keys for every list of string keys.

Traversal: in an object (dict) a token is a key. In an array (list) a token must be "0" or a
decimal number without leading zeros that indexes an existing element. The token "-" means "the
element after the last one": get() rejects it, set() appends there.

get(doc, pointer[, default]) returns the referenced value. If the value does not exist it returns
`default` when one is given, and raises JsonPointerError otherwise. A malformed pointer always
raises.

set(doc, pointer, value) changes doc in place and returns the (possibly new) root: pointer ""
returns `value` itself. The parent of the target must exist. For an object parent the key is added
or replaced. For an array parent, an existing index is replaced and "-" or an index equal to the
array length appends.
"""

from __future__ import annotations

import re
from typing import Any

_MISSING = object()
_INDEX = re.compile(r"^(0|[1-9][0-9]*)$")
_BAD_ESCAPE = re.compile(r"~(?![01])")


class JsonPointerError(LookupError):
    pass


def escape(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def unescape(token: str) -> str:
    if _BAD_ESCAPE.search(token):
        raise JsonPointerError(f"invalid escape in token {token!r}")
    return token.replace("~1", "/").replace("~0", "~")


def parse(pointer: str) -> list[str]:
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise JsonPointerError(f"pointer must be empty or start with '/': {pointer!r}")
    return [unescape(tok) for tok in pointer[1:].split("/")]


def to_pointer(keys: list[str]) -> str:
    return "".join("/" + escape(k) for k in keys)


def _index(token: str, arr: list, allow_end: bool) -> int:
    if allow_end and token == "-":
        return len(arr)
    if not _INDEX.match(token):
        raise JsonPointerError(f"invalid array index {token!r}")
    i = int(token)
    if i > len(arr) or (i == len(arr) and not allow_end):
        raise JsonPointerError(f"array index {i} out of range (length {len(arr)})")
    return i


def _child(node: Any, token: str) -> Any:
    if isinstance(node, dict):
        if token not in node:
            raise JsonPointerError(f"no member {token!r}")
        return node[token]
    if isinstance(node, list):
        return node[_index(token, node, allow_end=False)]
    raise JsonPointerError(f"cannot descend into {type(node).__name__} with {token!r}")


def get(doc: Any, pointer: str, default: Any = _MISSING) -> Any:
    tokens = parse(pointer)
    node = doc
    try:
        for token in tokens:
            node = _child(node, token)
    except JsonPointerError:
        if default is _MISSING:
            raise
        return default
    return node


def set(doc: Any, pointer: str, value: Any) -> Any:
    tokens = parse(pointer)
    if not tokens:
        return value
    parent = doc
    for token in tokens[:-1]:
        parent = _child(parent, token)
    last = tokens[-1]
    if isinstance(parent, dict):
        parent[last] = value
    elif isinstance(parent, list):
        i = _index(last, parent, allow_end=True)
        if i == len(parent):
            parent.append(value)
        else:
            parent[i] = value
    else:
        raise JsonPointerError(f"cannot set {last!r} on {type(parent).__name__}")
    return doc
