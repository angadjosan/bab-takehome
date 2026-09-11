"""Money parsing, rounding, formatting and allocation.

All amounts are :class:`decimal.Decimal`. Floats are rejected so binary
rounding error can never leak into a ledger.
"""

from __future__ import annotations

import math
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from fractions import Fraction
from typing import Sequence, Union

Number = Union[Decimal, int, str]

CENT = Decimal("0.01")
_GROUPED = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?"
_PLAIN = r"\d+(?:\.\d+)?|\.\d+"
_AMOUNT_RE = re.compile(rf"(?:{_GROUPED}|{_PLAIN})")


class MoneyError(ValueError):
    """Raised for malformed amounts or invalid allocation requests."""


def _to_decimal(value: Number) -> Decimal:
    if isinstance(value, bool) or isinstance(value, float):
        raise MoneyError(f"{type(value).__name__} is not accepted; use Decimal, int or str")
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(value)
    except (InvalidOperation, TypeError) as exc:
        raise MoneyError(f"invalid amount: {value!r}") from exc


def parse_amount(text: str) -> Decimal:
    """Parse a human-entered amount.

    Accepted forms: ``"12"``, ``"12.5"``, ``"1,234.50"``, ``"$1,234.50"``,
    ``"-3.10"``, ``"-$3.10"``, ``"+4"`` and accounting negatives ``"(12.50)"``
    or ``"($12.50)"``. Surrounding whitespace is ignored. The result is not
    rounded; call :func:`to_cents` for that.
    """
    if not isinstance(text, str):
        raise MoneyError(f"amount must be a string, got {type(text).__name__}")
    s = text.strip()
    negative = False
    if len(s) >= 2 and s[0] == "(" and s[-1] == ")":
        negative = True
        s = s[1:-1].strip()
    if s[:1] in ("+", "-"):
        if negative:  # "(-5)" is ambiguous
            raise MoneyError(f"invalid amount: {text!r}")
        negative = s[0] == "-"
        s = s[1:].lstrip()
    if s.startswith("$"):
        s = s[1:].lstrip()
    if not _AMOUNT_RE.fullmatch(s):
        raise MoneyError(f"invalid amount: {text!r}")
    value = Decimal(s.replace(",", ""))
    return -value if negative and value else value


def to_cents(value: Number) -> Decimal:
    """Round to whole cents, half away from zero.

    ``0.005 -> 0.01`` and ``-0.005 -> -0.01``. Negative zero is normalised
    to ``0.00``.
    """
    q = _to_decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)
    return abs(q) if q == 0 else q


def format_money(value: Number, symbol: str = "$") -> str:
    """Format as ``-$1,234.50`` (sign first, thousands separators, 2 places)."""
    q = to_cents(value)
    sign = "-" if q < 0 else ""
    return f"{sign}{symbol}{abs(q):,.2f}"


def allocate(total: Number, weights: Sequence[Union[int, Decimal]]) -> list[Decimal]:
    """Split ``total`` into cent amounts proportional to ``weights``.

    Uses the largest remainder method: every share first receives the floor
    of its exact share in whole cents; the leftover cents are then handed
    out one at a time to the shares with the largest fractional remainders
    (ties go to the lower index). The shares always sum exactly to
    ``to_cents(total)``. A negative total is allocated as the mirror image of
    the corresponding positive total. Weights must be non-negative ints or
    Decimals and at least one must be positive.
    """
    if not weights:
        raise MoneyError("weights must not be empty")
    fracs: list[Fraction] = []
    for w in weights:
        if isinstance(w, (bool, float)) or not isinstance(w, (int, Decimal)):
            raise MoneyError(f"invalid weight: {w!r}")
        f = Fraction(w)
        if f < 0:
            raise MoneyError("weights must be non-negative")
        fracs.append(f)
    wsum = sum(fracs)
    if wsum == 0:
        raise MoneyError("at least one weight must be positive")

    t = to_cents(total)
    shares = []
    for f in fracs:
        ratio = f / wsum
        shares.append(to_cents(t * ratio.numerator / ratio.denominator))
    return shares
