from decimal import Decimal as D

from ledgerlite.money import allocate, format_money, parse_amount, to_cents


def test_half_cent_rounds_away_from_zero():
    assert to_cents("0.005") == D("0.01")
    assert to_cents("-0.005") == D("-0.01")


def test_cases_where_half_even_differs():
    assert to_cents(D("2.665")) == D("2.67")
    assert to_cents(D("0.125")) == D("0.13")
    assert to_cents(D("10.005")) == D("10.01")


def test_negative_amounts_mirror_positive():
    assert to_cents("-2.665") == D("-2.67")
    assert to_cents(D("-0.125")) == D("-0.13")


def test_non_half_values_unchanged():
    assert to_cents("1.004") == D("1.00")
    assert to_cents("1.006") == D("1.01")
    assert to_cents("-1.004") == D("-1.00")
    assert str(to_cents("-0.001")) == "0.00"


def test_format_money_follows_policy():
    assert format_money("1234.565") == "$1,234.57"
    assert format_money("-0.005") == "-$0.01"


def test_allocate_rounds_total_by_policy():
    assert sum(allocate("10.005", [1, 1])) == D("10.01")


def test_parse_then_round():
    assert to_cents(parse_amount("($1,000.125)")) == D("-1000.13")
