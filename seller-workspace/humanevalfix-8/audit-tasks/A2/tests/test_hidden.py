"""Hidden test: the upstream `test` field of Python/49 (HumanEvalPack, MIT), unchanged except that
the trailing module-level `check(modp)` call is replaced by the pytest test at the bottom."""
from hefix.modp import *  # noqa: F401,F403 (helpers the upstream test may use)
from hefix.modp import modp

def check(modp):
    assert modp(3, 5) == 3
    assert modp(1101, 101) == 2
    assert modp(0, 101) == 1
    assert modp(3, 11) == 8
    assert modp(100, 101) == 1
    assert modp(30, 5) == 4
    assert modp(31, 5) == 3


def test_upstream_check():
    check(modp)
