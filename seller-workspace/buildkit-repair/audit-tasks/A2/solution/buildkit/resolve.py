"""Choose one version per package that satisfies every requirement placed on it.

resolve(requirements, index)
    requirements  iterable of (requester, package, range) triples, e.g. ("web", "yaml", "^1.4.0")
    index         mapping package -> iterable of available version strings

Returns {package: version} for every required package, with keys in sorted order. The chosen
version is the highest available one (semver precedence, see buildkit.semver) that satisfies ALL
of the ranges given for that package. Each range is checked on its own with
buildkit.semver.satisfies, so a range may contain "||" alternatives. Among versions of equal
precedence (differing only in build metadata) the one listed first in the index wins. The version
string is returned exactly as listed.

ResolutionError is raised when a required package is not in the index, or when no available
version satisfies all of its ranges. The message names the package and lists every requirement on
it as "requester: range", sorted by requester.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from buildkit.semver import parse, satisfies


class ResolutionError(Exception):
    pass


def resolve(requirements: Iterable[tuple[str, str, str]], index: Mapping[str, Iterable[str]]) -> dict[str, str]:
    wanted: dict[str, list[tuple[str, str]]] = {}
    for requester, package, range_text in requirements:
        wanted.setdefault(package, []).append((requester, range_text))
    result: dict[str, str] = {}
    for package in sorted(wanted):
        reqs = sorted(wanted[package])
        detail = ", ".join(f"{who}: {rng}" for who, rng in reqs)
        if package not in index:
            raise ResolutionError(f"{package} is not in the index (required by {detail})")
        best = None
        for text in index[package]:
            if all(satisfies(text, rng) for _, rng in reqs) and (best is None or parse(text) > parse(best)):
                best = text
        if best is None:
            raise ResolutionError(f"no version of {package} satisfies {detail}")
        result[package] = best
    return result
