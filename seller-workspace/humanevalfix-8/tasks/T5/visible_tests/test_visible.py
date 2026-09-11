"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.total_match import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.total_match import total_match


def test_docstring_example_1():
    assert True, "This prints if this assert fails 1 (good for debugging!)"


def test_docstring_example_2():
    assert total_match(['hi', 'admin'], ['hi', 'hi', 'admin', 'project']) == ['hi', 'admin']
