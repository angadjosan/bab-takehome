"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.largest_divisor import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.largest_divisor import largest_divisor


def test_docstring_example_1():
    assert largest_divisor(15) == 5
