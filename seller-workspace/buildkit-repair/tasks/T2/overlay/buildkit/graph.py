"""Dependency-graph ordering for build targets.

A graph is a mapping {node: iterable of the nodes it depends on}. A dependency that is not itself
a key is a node with no dependencies. Node names are strings.

topo_order(graph) returns every node exactly once, each one after all of its dependencies. Ties
are broken deterministically: at every step the next node is the smallest (plain str ordering)
node whose dependencies have all been emitted already. The result depends only on the graph, not
on dict or set iteration order.

build_levels(graph) groups nodes into waves that can be built in parallel: level 0 holds the
nodes without dependencies, level k the nodes whose deepest dependency is in level k-1. Each level
is sorted.

affected(graph, changed) returns the changed nodes plus every node that depends on one of them,
directly or transitively, in topo_order order.

On a cycle all three raise CycleError. Its .cycle attribute is one cycle written as a closed path
along dependency edges (node -> a dependency of it) that starts and ends at the cycle's smallest
member: ["a", "c", "b", "a"] means a depends on c, c on b and b on a. A self-dependency is
["a", "a"]. The cycle reported is the one reached by starting at the smallest node that could not
be ordered and repeatedly moving to its smallest dependency that could not be ordered.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Mapping


class CycleError(ValueError):
    def __init__(self, cycle: list[str]) -> None:
        self.cycle = list(cycle)
        super().__init__("dependency cycle: " + " -> ".join(self.cycle))


def _normalize(graph: Mapping[str, Iterable[str]]) -> dict[str, set[str]]:
    deps: dict[str, set[str]] = {}
    for node, ds in graph.items():
        ds = list(ds)
        deps.setdefault(node, set()).update(ds)
        for d in ds:
            deps.setdefault(d, set())
    return deps


def _find_cycle(deps: dict[str, set[str]], done: set[str]) -> list[str]:
    node = min(n for n in deps if n not in done)
    path: list[str] = []
    seen: dict[str, int] = {}
    while node not in seen:
        seen[node] = len(path)
        path.append(node)
        node = min(d for d in deps[node] if d not in done)
    cycle = path[seen[node]:]
    start = cycle.index(min(cycle))
    cycle = cycle[start:] + cycle[:start]
    return cycle + [cycle[0]]


def topo_order(graph: Mapping[str, Iterable[str]]) -> list[str]:
    deps = _normalize(graph)
    dependents: dict[str, list[str]] = {n: [] for n in deps}
    pending = {n: len(ds) for n, ds in deps.items()}
    for node, ds in deps.items():
        for d in ds:
            dependents[d].append(node)
    ready = deque(sorted(n for n, count in pending.items() if count == 0))
    order: list[str] = []
    while ready:
        node = ready.popleft()
        order.append(node)
        for m in dependents[node]:
            pending[m] -= 1
            if pending[m] == 0:
                ready.append(m)
    if len(order) != len(deps):
        raise CycleError(_find_cycle(deps, set(order)))
    return order


def build_levels(graph: Mapping[str, Iterable[str]]) -> list[list[str]]:
    deps = _normalize(graph)
    level: dict[str, int] = {}
    for node in topo_order(graph):
        level[node] = 1 + max((level[d] for d in deps[node]), default=-1)
    levels: list[list[str]] = [[] for _ in range(max(level.values(), default=-1) + 1)]
    for node, k in level.items():
        levels[k].append(node)
    return [sorted(nodes) for nodes in levels]


def affected(graph: Mapping[str, Iterable[str]], changed: Iterable[str]) -> list[str]:
    deps = _normalize(graph)
    hit = {c for c in changed if c in deps}
    for node in topo_order(graph):
        if deps[node] & hit:
            hit.add(node)
    return [n for n in topo_order(graph) if n in hit]
