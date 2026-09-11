"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.find_closest_elements import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.find_closest_elements import find_closest_elements


def test_docstring_example_1():
    assert find_closest_elements([1.0, 2.0, 3.0, 4.0, 5.0, 2.2]) == (2.0, 2.2)
