"""ledgerlite: a small, dependency-free bookkeeping toolkit.

Modules
-------
money      parse, round, format and allocate Decimal amounts
dates      timestamp parsing and UTC calendar periods
csvimport  import transactions from CSV exports
lru        a fixed-capacity least-recently-used cache
ratelimit  a token-bucket rate limiter with an injectable clock
tokenizer  split free-text memos into words, amounts, hashtags, mentions
ledger     an in-memory ledger with memoised balance queries
report     monthly totals, account statements and plain-text tables
"""

__version__ = "1.0.0"

from .money import MoneyError, allocate, format_money, parse_amount, to_cents
from .dates import (
    Period,
    add_months,
    days_in_month,
    iter_months,
    month_key,
    month_period,
    parse_timestamp,
    to_utc,
)
from .csvimport import CsvImportError, Transaction, parse_transactions, read_transactions
from .lru import LRUCache
from .ratelimit import TokenBucket
from .tokenizer import Token, amounts_in, hashtags, tokenize
from .ledger import Ledger
from .report import Statement, format_statement, monthly_totals, render_table, statement

__all__ = [
    "CsvImportError",
    "LRUCache",
    "Ledger",
    "MoneyError",
    "Period",
    "Statement",
    "Token",
    "TokenBucket",
    "Transaction",
    "add_months",
    "allocate",
    "amounts_in",
    "days_in_month",
    "format_money",
    "format_statement",
    "hashtags",
    "iter_months",
    "month_key",
    "month_period",
    "monthly_totals",
    "parse_amount",
    "parse_timestamp",
    "parse_transactions",
    "read_transactions",
    "render_table",
    "statement",
    "to_cents",
    "to_utc",
    "tokenize",
]
