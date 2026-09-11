"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.is_prime import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.is_prime import is_prime


def test_docstring_example_1():
    assert is_prime(6) == False


def test_docstring_example_2():
    assert is_prime(101) == True
