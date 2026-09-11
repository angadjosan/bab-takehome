"""Hidden test: the upstream `test` field of Python/20 (HumanEvalPack, MIT), unchanged except that
the trailing module-level `check(find_closest_elements)` call is replaced by the pytest test at the bottom."""
from hefix.find_closest_elements import *  # noqa: F401,F403 (helpers the upstream test may use)
from hefix.find_closest_elements import find_closest_elements

def check(find_closest_elements):
    assert find_closest_elements([1.0, 2.0, 3.9, 4.0, 5.0, 2.2]) == (3.9, 4.0)
    assert find_closest_elements([1.0, 2.0, 5.9, 4.0, 5.0]) == (5.0, 5.9)
    assert find_closest_elements([1.0, 2.0, 3.0, 4.0, 5.0, 2.2]) == (2.0, 2.2)
    assert find_closest_elements([1.0, 2.0, 3.0, 4.0, 5.0, 2.0]) == (2.0, 2.0)
    assert find_closest_elements([1.1, 2.2, 3.1, 4.1, 5.1]) == (2.2, 3.1)


def test_upstream_check():
    check(find_closest_elements)
