"""Split free-text transaction memos into typed tokens.

Token kinds:

``amount``   ``12``, ``12.50``, ``1,234.50``, ``$1,234.50``, ``-$3.10``;
             ``value`` is the Decimal amount (commas removed)
``hashtag``  ``#rent``; ``value`` is the lower-cased tag without ``#``
``mention``  ``@acme``; ``value`` is the lower-cased name without ``@``
``word``     letters with optional apostrophes (``don't``); ``value`` is
             the lower-cased word

Anything else (punctuation, stray symbols) is skipped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Union

from .money import parse_amount

_TOKEN_RE = re.compile(
    r"""
      (?P<amount>-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)
    | (?P<hashtag>\#[A-Za-z0-9_]+)
    | (?P<mention>@[A-Za-z0-9_]+)
    | (?P<word>[A-Za-z]+(?:'[A-Za-z]+)*)
    """,
    re.VERBOSE,
)


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    value: Union[str, Decimal]


def tokenize(text: str) -> list[Token]:
    tokens: list[Token] = []
    for m in _TOKEN_RE.finditer(text):
        kind = m.lastgroup
        raw = m.group()
        if kind == "amount":
            value: Union[str, Decimal] = parse_amount(raw)
        elif kind in ("hashtag", "mention"):
            value = raw[1:].lower()
        else:
            value = raw.lower()
        tokens.append(Token(kind, raw, value))
    return tokens


def amounts_in(text: str) -> list[Decimal]:
    return [t.value for t in tokenize(text) if t.kind == "amount"]  # type: ignore[misc]


def hashtags(text: str) -> list[str]:
    return [t.value for t in tokenize(text) if t.kind == "hashtag"]  # type: ignore[misc]
