from decimal import Decimal

from ledgerlite.money import allocate


def test_split_ten_dollars_three_ways_keeps_total():
    shares = allocate(Decimal("10.00"), [1, 1, 1])
    assert sum(shares) == Decimal("10.00"), shares
