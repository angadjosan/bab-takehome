import pytest

from buildkit.resolve import ResolutionError, resolve


def test_alternatives_do_not_bypass_other_requirements():
    reqs = [("cli", "yaml", "^1.4.0 || ^2.0.0"), ("web", "yaml", ">=2.0.0")]
    with pytest.raises(ResolutionError):
        resolve(reqs, {"yaml": ["1.4.2", "1.9.0"]})
    assert resolve(reqs, {"yaml": ["1.9.0", "2.0.1", "3.0.0"]}) == {"yaml": "2.0.1"}


def test_every_range_applies_even_after_an_alternative():
    reqs = [("a", "p", "^1.0.0"), ("b", "p", ">=1.0.0 <1.5.0 || >=3.0.0")]
    assert resolve(reqs, {"p": ["1.2.0", "1.8.0", "3.1.0"]}) == {"p": "1.2.0"}


def test_two_ranges_with_alternatives():
    reqs = [("a", "p", "<1.0.0 || >=2.0.0"), ("b", "p", "^1.0.0 || ^2.0.0")]
    assert resolve(reqs, {"p": ["0.9.0", "1.5.0", "2.3.0", "3.0.0"]}) == {"p": "2.3.0"}
    reqs = [("a", "p", "^1.0.0 || ^3.0.0"), ("b", "p", "^1.0.0 || ^2.0.0")]
    assert resolve(reqs, {"p": ["1.1.0", "2.9.0", "3.4.0"]}) == {"p": "1.1.0"}


def test_highest_version_satisfying_all_is_chosen():
    reqs = [("app", "left-pad", "^1.1.0"), ("lib", "left-pad", "<1.3.0"), ("app", "chalk", "*")]
    index = {"left-pad": ["1.0.0", "1.1.3", "1.2.9", "1.3.0"], "chalk": ["4.1.2", "5.3.0", "5.2.0"]}
    result = resolve(reqs, index)
    assert result == {"chalk": "5.3.0", "left-pad": "1.2.9"}
    assert list(result) == ["chalk", "left-pad"]


def test_conflict_message_lists_requirements_sorted():
    reqs = [("web", "yaml", "^2.0.0"), ("cli", "yaml", "^1.0.0")]
    with pytest.raises(ResolutionError, match=r"yaml.*cli: \^1\.0\.0, web: \^2\.0\.0"):
        resolve(reqs, {"yaml": ["1.0.0", "2.0.0"]})


def test_missing_package():
    with pytest.raises(ResolutionError, match="ghost"):
        resolve([("app", "ghost", "*")], {"yaml": ["1.0.0"]})


def test_prereleases_follow_semver_rules():
    reqs = [("a", "p", "^1.2.0-beta.1"), ("b", "p", "<=1.2.0-rc.1")]
    assert resolve(reqs, {"p": ["1.2.0-beta.4", "1.2.0-rc.1", "1.2.0"]}) == {"p": "1.2.0-rc.1"}
    with pytest.raises(ResolutionError):
        resolve([("a", "p", "^1.2.0"), ("b", "p", "<1.3.0 || ^2.0.0")], {"p": ["1.3.0-beta.1", "2.0.0-rc.1"]})


def test_version_returned_as_listed_and_ties_keep_index_order():
    reqs = [("a", "p", ">=1.0.0"), ("b", "p", "1.x || 2.x")]
    assert resolve(reqs, {"p": ["v1.4.0", "1.4.0+b2"]}) == {"p": "v1.4.0"}
