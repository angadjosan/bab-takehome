"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""
from hefix.even_odd_palindrome import *  # noqa: F401,F403 (helpers the examples may use)
from hefix.even_odd_palindrome import even_odd_palindrome


def test_docstring_example_1():
    assert even_odd_palindrome(12) == (4, 6)


def test_docstring_example_2():
    assert even_odd_palindrome(3) == (1, 2)
