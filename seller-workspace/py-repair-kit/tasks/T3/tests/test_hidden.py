from decimal import Decimal as D

import pytest

from ledgerlite.money import MoneyError, allocate, to_cents


def test_three_way_split_of_100():
    assert allocate(D("100.00"), [1, 1, 1]) == [D("33.34"), D("33.33"), D("33.33")]


def test_sum_is_always_preserved():
    totals = ["0.01", "0.02", "0.05", "1.00", "10.00", "99.99", "100.00", "1234.57", "-7.01"]
    weight_sets = [[1, 1], [1, 1, 1], [1, 2, 3], [3, 3, 1], [7, 0, 5, 1], [1] * 7]
    for t in totals:
        for w in weight_sets:
            shares = allocate(D(t), w)
            assert len(shares) == len(w)
            assert sum(shares) == to_cents(t), (t, w, shares)


def test_leftover_cents_go_to_largest_remainder_first():
    assert allocate(D("1.00"), [1, 2, 3]) == [D("0.17"), D("0.33"), D("0.50")]
    assert allocate(D("1.00"), [D("0.3333"), D("0.3333"), D("0.3334")]) == [D("0.33"), D("0.33"), D("0.34")]


def test_ties_go_to_lower_index():
    assert allocate(D("0.05"), [1, 1, 1, 1]) == [D("0.02"), D("0.01"), D("0.01"), D("0.01")]
    assert allocate(D("0.02"), [1, 1, 1]) == [D("0.01"), D("0.01"), D("0.00")]
    assert allocate(D("0.01"), [1, 1]) == [D("0.01"), D("0.00")]


def test_negative_total_mirrors_positive():
    assert allocate(D("-100.00"), [1, 1, 1]) == [D("-33.34"), D("-33.33"), D("-33.33")]
    assert allocate(D("-0.05"), [1, 1]) == [D("-0.03"), D("-0.02")]


def test_zero_weight_receives_nothing():
    assert allocate(D("10.00"), [0, 1, 1]) == [D("0.00"), D("5.00"), D("5.00")]
    assert allocate(D("0.03"), [0, 1, 1]) == [D("0.00"), D("0.02"), D("0.01")]


def test_total_is_rounded_to_cents_before_splitting():
    shares = allocate("10.005", [1, 1])
    assert shares == [D("5.01"), D("5.00")]


def test_decimal_weights():
    assert allocate(D("10.00"), [D("0.5"), D("0.25"), D("0.25")]) == [D("5.00"), D("2.50"), D("2.50")]


def test_shares_are_quantized_to_cents():
    for share in allocate(D("12.34"), [1, 1, 1, 4]):
        assert share.as_tuple().exponent == -2


@pytest.mark.parametrize("weights", [[], [-1, 2], [0, 0], [1.5, 1]])
def test_invalid_weights_rejected(weights):
    with pytest.raises(MoneyError):
        allocate(D("1.00"), weights)
