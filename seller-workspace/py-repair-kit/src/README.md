# ledgerlite

A small, dependency-free (Python 3.12 standard library only) bookkeeping toolkit.

| Module | What it does |
|---|---|
| `ledgerlite/money.py` | Parse amounts (`"$1,234.50"`, `"(12.50)"`), round to cents half away from zero, format, allocate a total across weights (largest remainder method) |
| `ledgerlite/dates.py` | Parse ISO timestamps, convert to UTC, UTC calendar-month periods (half-open), month arithmetic |
| `ledgerlite/csvimport.py` | Import transactions from CSV exports (header aliases, UTF-8 BOM tolerated) |
| `ledgerlite/lru.py` | Fixed-capacity least-recently-used cache |
| `ledgerlite/ratelimit.py` | Continuous-refill token bucket with an injectable clock |
| `ledgerlite/tokenizer.py` | Split memos into words, amounts, hashtags and mentions |
| `ledgerlite/ledger.py` | In-memory ledger with memoised balances |
| `ledgerlite/report.py` | Monthly totals, account statements, plain-text tables |

All amounts are `decimal.Decimal`; floats are rejected. All reporting periods are UTC calendar
months treated as half-open intervals; timestamps with an offset are placed by their UTC instant and
naive timestamps are UTC.

```python
from ledgerlite import Ledger, parse_transactions, statement, format_statement

ledger = Ledger()
ledger.extend(parse_transactions(open("export.csv", encoding="utf-8-sig").read()))
print(format_statement(statement(ledger, "checking", 2024, 3)))
```
