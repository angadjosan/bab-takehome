import pytest

from buildkit.resolve import ResolutionError, resolve


def test_conflicting_requirements_are_reported():
    reqs = [("cli", "yaml", "^1.4.0 || ^2.0.0"), ("web", "yaml", ">=2.0.0")]
    with pytest.raises(ResolutionError):
        resolve(reqs, {"yaml": ["1.4.2", "1.9.0"]})
