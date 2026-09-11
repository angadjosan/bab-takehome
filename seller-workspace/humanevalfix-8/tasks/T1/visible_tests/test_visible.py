"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.below_zero import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.below_zero import below_zero


def test_docstring_example_1():
    assert below_zero([1, 2, 3]) == False


def test_docstring_example_2():
    assert below_zero([1, 2, -4, 5]) == True
