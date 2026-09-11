"""Hidden test: the upstream `test` field of Python/46 (HumanEvalPack, MIT), unchanged except that
the trailing module-level `check(fib4)` call is replaced by the pytest test at the bottom."""
from hefix.fib4 import *  # noqa: F401,F403 (helpers the upstream test may use)
from hefix.fib4 import fib4

def check(fib4):
    assert fib4(5) == 4
    assert fib4(8) == 28
    assert fib4(10) == 104
    assert fib4(12) == 386


def test_upstream_check():
    check(fib4)
