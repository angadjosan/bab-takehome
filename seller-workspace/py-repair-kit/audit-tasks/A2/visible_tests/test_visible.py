from decimal import Decimal

from ledgerlite.money import to_cents


def test_half_cent_rounds_up():
    assert to_cents(Decimal("0.625")) == Decimal("0.63")
