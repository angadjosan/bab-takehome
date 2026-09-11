from buildkit.graph import build_levels, topo_order


def test_newly_ready_target_is_ordered_by_name():
    assert topo_order({"libcore": [], "app": ["libcore"], "tests": []}) == ["libcore", "app", "tests"]


def test_build_levels():
    assert build_levels({"app": ["lib"], "lib": [], "docs": []}) == [["docs", "lib"], ["app"]]
