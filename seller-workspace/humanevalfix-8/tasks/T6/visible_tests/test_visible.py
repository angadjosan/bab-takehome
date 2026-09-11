"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.is_multiply_prime import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.is_multiply_prime import is_multiply_prime


def test_docstring_example_1():
    assert is_multiply_prime(30) == True
