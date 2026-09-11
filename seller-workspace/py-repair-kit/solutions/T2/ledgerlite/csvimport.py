"""Import transactions from CSV exports.

The first row is a header. Column names are matched case-insensitively,
ignoring surrounding whitespace, and a few common aliases are understood
(``posted``/``timestamp`` for ``date``, ``acct`` for ``account``, ``value``
for ``amount``, ``description``/``note`` for ``memo``). Files exported by
spreadsheet tools often start with a UTF-8 byte-order mark; it is ignored.
"""

from __future__ import annotations

import csv
import io
import os
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Union

from .dates import parse_timestamp
from .money import parse_amount

HEADER_ALIASES = {
    "date": "date",
    "timestamp": "date",
    "posted": "date",
    "account": "account",
    "acct": "account",
    "amount": "amount",
    "value": "amount",
    "memo": "memo",
    "description": "memo",
    "note": "memo",
}
REQUIRED = ("date", "account", "amount")


class CsvImportError(ValueError):
    """Raised when a CSV export cannot be imported."""


@dataclass(frozen=True)
class Transaction:
    timestamp: datetime
    account: str
    amount: Decimal
    memo: str = ""


def _normalize_header(name: str) -> Union[str, None]:
    return HEADER_ALIASES.get(name.strip().lower().replace(" ", "_"))


def parse_transactions(text: str) -> list[Transaction]:
    """Parse CSV text into transactions. Blank rows are skipped."""
    if text.startswith("\ufeff"):
        text = text[1:]
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader, None)
    if header is None:
        return []
    columns: dict[str, int] = {}
    for idx, name in enumerate(header):
        key = _normalize_header(name)
        if key is not None and key not in columns:
            columns[key] = idx
    missing = [c for c in REQUIRED if c not in columns]
    if missing:
        raise CsvImportError(f"missing required column(s): {', '.join(missing)}")

    out: list[Transaction] = []
    for row in reader:
        if not row or all(not cell.strip() for cell in row):
            continue

        def cell(key: str) -> str:
            i = columns.get(key)
            return row[i].strip() if i is not None and i < len(row) else ""

        try:
            ts = parse_timestamp(cell("date"))
            amount = parse_amount(cell("amount"))
        except ValueError as exc:
            raise CsvImportError(f"line {reader.line_num}: {exc}") from exc
        account = cell("account")
        if not account:
            raise CsvImportError(f"line {reader.line_num}: empty account")
        out.append(Transaction(ts, account, amount, cell("memo")))
    return out


def read_transactions(path: Union[str, os.PathLike]) -> list[Transaction]:
    """Read a CSV file (UTF-8, optional BOM) and parse it."""
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return parse_transactions(fh.read())
