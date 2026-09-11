"""Hidden test: the upstream `test` field of Python/3 (HumanEvalPack, MIT), unchanged except that
the trailing module-level `check(below_zero)` call is replaced by the pytest test at the bottom."""
from hefix.below_zero import *  # noqa: F401,F403 (helpers the upstream test may use)
from hefix.below_zero import below_zero

def check(below_zero):
    assert below_zero([]) == False
    assert below_zero([1, 2, -3, 1, 2, -3]) == False
    assert below_zero([1, 2, -4, 5, 6]) == True
    assert below_zero([1, -1, 2, -2, 5, -5, 4, -4]) == False
    assert below_zero([1, -1, 2, -2, 5, -5, 4, -5]) == True
    assert below_zero([1, -2, 2, -2, 5, -5, 4, -4]) == True


def test_upstream_check():
    check(below_zero)
