"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.reverse_delete import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.reverse_delete import reverse_delete


def test_docstring_example_1():
    assert reverse_delete("abcde","ae") == ('bcd',False)
