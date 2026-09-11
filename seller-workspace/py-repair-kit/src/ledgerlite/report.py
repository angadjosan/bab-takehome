"""Monthly totals, account statements and plain-text tables.

All periods follow the reporting policy in :mod:`ledgerlite.dates`: UTC
calendar months, half-open.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Optional, Sequence

from .csvimport import Transaction
from .dates import month_key, month_period, to_utc
from .money import format_money

ZERO = Decimal("0.00")


def monthly_totals(
    transactions: Iterable[Transaction], year: int, account: Optional[str] = None
) -> dict[int, Decimal]:
    """Net amount per UTC calendar month of ``year``; keys 1..12 always present."""
    totals = {m: ZERO for m in range(1, 13)}
    for tx in transactions:
        if account is not None and tx.account != account:
            continue
        y, m = month_key(tx.timestamp)
        if y == year:
            totals[m] += tx.amount
    return totals


@dataclass(frozen=True)
class Statement:
    account: str
    year: int
    month: int
    opening: Decimal
    credits: Decimal
    debits: Decimal
    closing: Decimal
    lines: tuple[Transaction, ...]


def statement(transactions: Iterable[Transaction], account: str, year: int, month: int) -> Statement:
    """Statement for ``account`` over the UTC month ``year-month``.

    ``opening`` is the sum of everything before the period, ``credits`` and
    ``debits`` the positive and negative amounts inside it, and
    ``closing = opening + credits + debits``.
    """
    period = month_period(year, month)
    opening = credits = debits = ZERO
    lines: list[Transaction] = []
    for tx in transactions:
        if tx.account != account:
            continue
        if to_utc(tx.timestamp) < period.start:
            opening += tx.amount
        elif period.contains(tx.timestamp):
            lines.append(tx)
            if tx.amount >= 0:
                credits += tx.amount
            else:
                debits += tx.amount
    lines.sort(key=lambda t: to_utc(t.timestamp))
    return Statement(account, year, month, opening, credits, debits, opening + credits + debits, tuple(lines))


def render_table(headers: Sequence[str], rows: Sequence[Sequence[object]]) -> str:
    """Render a fixed-width table; numeric-looking cells are right-aligned."""
    cells = [[str(h) for h in headers]] + [[str(c) for c in r] for r in rows]
    widths = [max(len(r[i]) for r in cells) for i in range(len(headers))]

    def fmt(row: list[str]) -> str:
        out = []
        for i, c in enumerate(row):
            numeric = c.replace(",", "").replace("$", "").lstrip("-").replace(".", "", 1).isdigit()
            out.append(c.rjust(widths[i]) if numeric else c.ljust(widths[i]))
        return "  ".join(out).rstrip()

    sep = "  ".join("-" * w for w in widths)
    return "\n".join([fmt(cells[0]), sep] + [fmt(r) for r in cells[1:]])


def format_statement(st: Statement) -> str:
    rows = [
        (to_utc(t.timestamp).strftime("%Y-%m-%d %H:%M"), t.memo, format_money(t.amount))
        for t in st.lines
    ]
    head = f"Statement {st.account} {st.year}-{st.month:02d} (UTC)"
    summary = (
        f"opening {format_money(st.opening)}  credits {format_money(st.credits)}  "
        f"debits {format_money(st.debits)}  closing {format_money(st.closing)}"
    )
    return "\n".join([head, render_table(["when", "memo", "amount"], rows), summary])
