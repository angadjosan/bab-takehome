from decimal import Decimal

from ledgerlite.csvimport import Transaction
from ledgerlite.dates import parse_timestamp
from ledgerlite.report import statement


def test_month_end_transaction_is_not_double_counted():
    book = [
        Transaction(parse_timestamp("2024-03-15T12:00:00Z"), "chk", Decimal("100.00")),
        Transaction(parse_timestamp("2024-04-01T00:00:00Z"), "chk", Decimal("-40.00")),
    ]
    mar = statement(book, "chk", 2024, 3)
    apr = statement(book, "chk", 2024, 4)
    assert mar.debits + apr.debits == Decimal("-40.00")
