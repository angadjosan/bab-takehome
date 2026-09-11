from buildkit.semver import max_satisfying, parse, satisfies, sort_versions


def test_numeric_prerelease_identifiers_compare_numerically():
    assert parse("2.0.0-rc.10") > parse("2.0.0-rc.9")
    assert parse("1.0.0-beta.11") > parse("1.0.0-beta.2")
    assert parse("1.0.0-9") < parse("1.0.0-10")


def test_semver_spec_precedence_chain():
    chain = [
        "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
        "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
    ]
    assert sort_versions(list(reversed(chain))) == chain
    for lower, higher in zip(chain, chain[1:]):
        assert parse(lower) < parse(higher)
        assert parse(higher) > parse(lower)


def test_numeric_identifier_ranks_below_alphanumeric():
    assert parse("1.0.0-1") < parse("1.0.0-alpha")
    assert parse("1.0.0-999") < parse("1.0.0-a")
    assert parse("1.0.0-x.2") < parse("1.0.0-x.10a")
    assert parse("1.0.0-x.10a") > parse("1.0.0-x.99")


def test_more_identifiers_rank_higher_when_prefix_equal():
    assert parse("1.0.0-alpha") < parse("1.0.0-alpha.0")
    assert parse("1.0.0-rc.1") < parse("1.0.0-rc.1.1")
    assert parse("1.0.0-rc.2") > parse("1.0.0-rc.1.5")


def test_long_numeric_identifiers():
    assert parse("1.0.0-nightly.20260901.12") > parse("1.0.0-nightly.20260901.3")
    assert parse("1.0.0-nightly.20260910.1") > parse("1.0.0-nightly.20260901.99")


def test_max_satisfying_picks_highest_release_candidate():
    assert max_satisfying(["2.0.0-rc.9", "2.0.0-rc.10", "2.0.0-rc.2"], ">=2.0.0-rc.1") == "2.0.0-rc.10"
    assert max_satisfying(["2.0.0-rc.9", "2.0.0-rc.10"], "~2.0.0-rc.1") == "2.0.0-rc.10"
    assert max_satisfying(["2.0.0-rc.10", "2.0.0"], "^2.0.0-rc.1") == "2.0.0"


def test_range_bounds_use_numeric_prerelease_order():
    assert not satisfies("1.0.0-beta.2", ">=1.0.0-beta.11")
    assert satisfies("1.0.0-beta.11", ">1.0.0-beta.2 <1.0.0")
    assert satisfies("1.0.0-beta.11", "^1.0.0-beta.2")
    assert not satisfies("1.0.0-beta.3", "<1.0.0-beta.3")


def test_release_above_prerelease_and_build_ignored():
    assert parse("1.2.3") > parse("1.2.3-rc.100")
    assert parse("1.2.3+build.5") == parse("1.2.3+other")
    assert len({parse("1.0.0-rc.1+x"), parse("1.0.0-rc.1")}) == 1
    assert sort_versions(["1.2.3+b", "1.2.3-rc.1", "1.2.3+a"]) == ["1.2.3-rc.1", "1.2.3+b", "1.2.3+a"]


def test_sort_mixed_versions():
    versions = ["1.10.0", "1.2.0", "1.2.0-rc.10", "1.2.0-rc.2", "0.9.12", "1.2.0-rc.2.1"]
    assert sort_versions(versions) == ["0.9.12", "1.2.0-rc.2", "1.2.0-rc.2.1", "1.2.0-rc.10", "1.2.0", "1.10.0"]


def test_ranges_still_work():
    assert satisfies("1.9.9", "^1.2.3") and not satisfies("2.0.0", "^1.2.3")
    assert satisfies("0.2.9", "^0.2.3") and not satisfies("0.3.0", "^0.2.3")
    assert satisfies("1.2.9", "~1.2.3") and not satisfies("1.3.0", "~1.2.3")
    assert not satisfies("1.3.0-beta.1", "^1.2.0")
    assert satisfies("3.1.0", "1.x || >=3.0.0 <4")
