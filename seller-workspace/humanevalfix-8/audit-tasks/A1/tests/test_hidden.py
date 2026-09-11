"""Hidden test: the upstream `test` field of Python/24 (HumanEvalPack, MIT), unchanged except that
the trailing module-level `check(largest_divisor)` call is replaced by the pytest test at the bottom."""
from hefix.largest_divisor import *  # noqa: F401,F403 (helpers the upstream test may use)
from hefix.largest_divisor import largest_divisor

def check(largest_divisor):
    assert largest_divisor(3) == 1
    assert largest_divisor(7) == 1
    assert largest_divisor(10) == 5
    assert largest_divisor(100) == 50
    assert largest_divisor(49) == 7


def test_upstream_check():
    check(largest_divisor)
