import pytest

from buildkit.graph import CycleError, affected, build_levels, topo_order


def _reference_order(graph):
    """Literal reading of the docstring rule, O(n^2): smallest node whose deps are all emitted."""
    nodes = set(graph) | {d for ds in graph.values() for d in ds}
    done, order = set(), []
    while len(order) < len(nodes):
        nxt = min(n for n in nodes if n not in done and all(d in done for d in graph.get(n, ())))
        order.append(nxt)
        done.add(nxt)
    return order


def test_smallest_ready_node_first_after_unlock():
    assert topo_order({"libcore": [], "app": ["libcore"], "tests": []}) == ["libcore", "app", "tests"]


def test_diamond_with_side_node():
    graph = {"d": ["b", "c"], "b": ["a"], "c": ["a"], "a": [], "e": []}
    assert topo_order(graph) == ["a", "b", "c", "d", "e"]


def test_chain_beats_later_independent_node():
    graph = {"c3": ["c2"], "c2": ["c1"], "c1": [], "b": [], "d": []}
    assert topo_order(graph) == ["b", "c1", "c2", "c3", "d"]


def test_independent_of_insertion_order():
    g1 = {"z": ["m"], "m": [], "a": ["m"], "k": []}
    g2 = dict(reversed(list(g1.items())))
    assert topo_order(g1) == ["k", "m", "a", "z"]
    assert topo_order(g2) == ["k", "m", "a", "z"]


def test_implicit_nodes_and_set_values():
    assert topo_order({"app": {"zlib", "openssl"}, "openssl": ["zlib"]}) == ["zlib", "openssl", "app"]
    assert topo_order({}) == []


def test_generated_graph_follows_rule_exactly():
    graph = {f"n{i:02d}": [f"n{j:02d}" for j in range(i) if (i * j) % 7 == 1] for i in range(30)}
    graph.update({"n05": ["n29"], "n11": ["n28", "n02"]})
    order = topo_order(graph)
    pos = {n: i for i, n in enumerate(order)}
    assert sorted(order) == sorted(graph)
    for node, ds in graph.items():
        for d in ds:
            assert pos[d] < pos[node]
    assert order == _reference_order(graph)


def test_affected_in_topo_order():
    graph = {"app": ["lib"], "lib": ["core"], "cli": ["core"], "core": [], "docs": []}
    assert topo_order(graph) == ["core", "cli", "docs", "lib", "app"]
    assert affected(graph, ["core"]) == ["core", "cli", "lib", "app"]
    assert affected(graph, ["lib", "docs"]) == ["docs", "lib", "app"]


def test_build_levels():
    graph = {"app": ["lib", "util"], "lib": ["util"], "util": [], "docs": []}
    assert build_levels(graph) == [["docs", "util"], ["lib"], ["app"]]


def test_cycle_reported_from_smallest_member():
    with pytest.raises(CycleError) as err:
        topo_order({"b": ["c"], "c": ["a"], "a": ["b"], "app": ["b"]})
    assert err.value.cycle == ["a", "b", "c", "a"]
    assert isinstance(err.value, ValueError)


def test_cycle_reached_from_outside_is_rotated():
    with pytest.raises(CycleError) as err:
        topo_order({"a": ["z"], "z": ["y"], "y": ["x"], "x": ["z"]})
    assert err.value.cycle == ["x", "z", "y", "x"]
    with pytest.raises(CycleError) as err:
        build_levels({"app": ["m"], "m": ["n"], "n": ["m"]})
    assert err.value.cycle == ["m", "n", "m"]


def test_self_dependency():
    with pytest.raises(CycleError) as err:
        topo_order({"x": ["x"], "y": []})
    assert err.value.cycle == ["x", "x"]
