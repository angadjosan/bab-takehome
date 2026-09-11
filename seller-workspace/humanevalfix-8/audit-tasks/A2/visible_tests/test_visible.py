"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.modp import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.modp import modp


def test_docstring_example_1():
    assert modp(3, 5) == 3
