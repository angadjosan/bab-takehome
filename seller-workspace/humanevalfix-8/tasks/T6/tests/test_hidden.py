"""Hidden test: the upstream `test` field of Python/75 (HumanEvalPack, MIT), unchanged except that
the trailing module-level `check(is_multiply_prime)` call is replaced by the pytest test at the bottom."""
from hefix.is_multiply_prime import *  # noqa: F401,F403 (helpers the upstream test may use)
from hefix.is_multiply_prime import is_multiply_prime

def check(is_multiply_prime):

    assert is_multiply_prime(5) == False
    assert is_multiply_prime(30) == True
    assert is_multiply_prime(8) == True
    assert is_multiply_prime(10) == False
    assert is_multiply_prime(125) == True
    assert is_multiply_prime(3 * 5 * 7) == True
    assert is_multiply_prime(3 * 6 * 7) == False
    assert is_multiply_prime(9 * 9 * 9) == False
    assert is_multiply_prime(11 * 9 * 9) == False
    assert is_multiply_prime(11 * 13 * 7) == True


def test_upstream_check():
    check(is_multiply_prime)
