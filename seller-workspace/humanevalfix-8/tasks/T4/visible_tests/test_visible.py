"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.fib4 import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.fib4 import fib4


def test_docstring_example_1():
    assert fib4(5) == 4
