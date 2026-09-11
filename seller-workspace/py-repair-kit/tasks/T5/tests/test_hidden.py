from datetime import datetime, timedelta, timezone
from decimal import Decimal as D

from ledgerlite.csvimport import Transaction
from ledgerlite.dates import month_period, parse_timestamp
from ledgerlite.report import monthly_totals, statement


def tx(ts, amount, account="chk"):
    t = parse_timestamp(ts) if isinstance(ts, str) else ts
    return Transaction(t, account, D(amount), "")


BOOK = [
    tx("2023-12-31T20:00:00-06:00", "50.00"),  # 2024-01-01T02:00Z -> Jan 2024
    tx("2024-01-15T09:00:00-06:00", "100.00"),
    tx("2024-01-31T19:30:00-06:00", "-20.00"),  # 2024-02-01T01:30Z -> Feb
    tx("2024-02-29T23:59:59Z", "-5.00"),
    tx("2024-03-01T00:00:00Z", "7.00"),  # first instant of March
    tx("2024-03-31T21:30:00-05:00", "10.00"),  # 2024-04-01T02:30Z -> Apr
    tx("2024-04-01T00:00:00Z", "-40.00"),  # first instant of April
    tx(datetime(2024, 6, 30, 23, 59), "3.00"),  # naive -> UTC -> June
    tx("2024-07-01T01:00:00+02:00", "4.00"),  # 2024-06-30T23:00Z -> June
    tx("2024-12-31T20:00:00-05:00", "999.00"),  # 2025-01-01T01:00Z -> 2025
    tx("2024-05-10T12:00:00Z", "1.00", account="savings"),
]

EXPECTED_CHK_2024 = {m: D("0.00") for m in range(1, 13)}
EXPECTED_CHK_2024.update({1: D("150.00"), 2: D("-25.00"), 3: D("7.00"), 4: D("-30.00"), 6: D("7.00")})


def test_monthly_totals_bucket_by_utc_instant():
    assert monthly_totals(BOOK, 2024, account="chk") == EXPECTED_CHK_2024


def test_negative_offset_evening_moves_to_next_month():
    totals = monthly_totals([tx("2024-03-31T21:30:00-05:00", "10.00")], 2024)
    assert totals[3] == D("0.00")
    assert totals[4] == D("10.00")


def test_positive_offset_early_morning_moves_to_previous_month():
    totals = monthly_totals([tx("2024-05-01T01:15:00+02:00", "8.00")], 2024)
    assert totals[4] == D("8.00")
    assert totals[5] == D("0.00")


def test_naive_timestamp_is_utc():
    totals = monthly_totals([tx(datetime(2024, 6, 30, 23, 59), "3.00")], 2024)
    assert totals[6] == D("3.00")


def test_first_instant_of_month_belongs_only_to_new_month():
    book = [tx("2024-04-01T00:00:00Z", "-40.00")]
    assert statement(book, "chk", 2024, 3).lines == ()
    assert len(statement(book, "chk", 2024, 4).lines) == 1


def test_period_is_half_open():
    p = month_period(2024, 2)
    assert p.contains(p.start)
    assert not p.contains(p.end)
    assert p.contains(p.end - timedelta(microseconds=1))
    assert p.contains(datetime(2024, 3, 1, 0, 30, tzinfo=timezone(timedelta(hours=1))))


def test_closing_rolls_into_next_opening():
    for m in range(1, 12):
        this = statement(BOOK, "chk", 2024, m)
        nxt = statement(BOOK, "chk", 2024, m + 1)
        assert this.closing == nxt.opening, m


def test_statement_activity_matches_monthly_totals():
    totals = monthly_totals(BOOK, 2024, account="chk")
    for m in range(1, 13):
        st = statement(BOOK, "chk", 2024, m)
        assert st.credits + st.debits == totals[m], m


def test_year_of_statements_reconciles():
    jan = statement(BOOK, "chk", 2024, 1)
    dec = statement(BOOK, "chk", 2024, 12)
    assert jan.opening == D("0.00")
    assert dec.closing - jan.opening == sum(EXPECTED_CHK_2024.values())


def test_statement_lines_sorted_by_utc_instant():
    apr = statement(BOOK, "chk", 2024, 4)
    assert [line.amount for line in apr.lines] == [D("-40.00"), D("10.00")]
