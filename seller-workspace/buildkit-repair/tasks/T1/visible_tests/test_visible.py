from buildkit.semver import max_satisfying, parse


def test_rc10_ranks_above_rc9():
    assert parse("2.0.0-rc.10") > parse("2.0.0-rc.9")


def test_max_satisfying_picks_latest_release_candidate():
    assert max_satisfying(["2.0.0-rc.9", "2.0.0-rc.10"], ">=2.0.0-rc.1") == "2.0.0-rc.10"
