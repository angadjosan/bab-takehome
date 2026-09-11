"""Hidden test: the upstream `test` field of Python/74 (HumanEvalPack, MIT), unchanged except that
the trailing module-level `check(total_match)` call is replaced by the pytest test at the bottom."""
from hefix.total_match import *  # noqa: F401,F403 (helpers the upstream test may use)
from hefix.total_match import total_match

def check(total_match):

    # Check some simple cases
    assert True, "This prints if this assert fails 1 (good for debugging!)"
    assert total_match([], []) == []
    assert total_match(['hi', 'admin'], ['hi', 'hi']) == ['hi', 'hi']
    assert total_match(['hi', 'admin'], ['hi', 'hi', 'admin', 'project']) == ['hi', 'admin']
    assert total_match(['4'], ['1', '2', '3', '4', '5']) == ['4']
    assert total_match(['hi', 'admin'], ['hI', 'Hi']) == ['hI', 'Hi']
    assert total_match(['hi', 'admin'], ['hI', 'hi', 'hi']) == ['hI', 'hi', 'hi']
    assert total_match(['hi', 'admin'], ['hI', 'hi', 'hii']) == ['hi', 'admin']


    # Check some edge cases that are easy to work out by hand.
    assert True, "This prints if this assert fails 2 (also good for debugging!)"
    assert total_match([], ['this']) == []
    assert total_match(['this'], []) == []


def test_upstream_check():
    check(total_match)
