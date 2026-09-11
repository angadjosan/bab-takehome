"""Semantic Versioning 2.0.0 versions and npm-style range matching.

Versions look like MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD], e.g. "1.4.0-rc.2+sha.5114f85"; a leading
"v" is accepted. Build metadata is kept but ignored for ordering and equality.

Precedence (semver.org, section 11): compare MAJOR, MINOR and PATCH numerically. A version with a
prerelease ranks below the same version without one. Prerelease identifiers are compared left to
right: identifiers made only of digits compare numerically, others compare in ASCII order, and a
numeric identifier always ranks below an alphanumeric one. If every shared identifier is equal, the
version with more identifiers ranks higher. Example of an ascending sequence:
1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11
< 1.0.0-rc.1 < 1.0.0.

Ranges are comparator sets separated by "||" (any set may match); inside a set, whitespace-separated
comparators must all match:
    1.2.3, =1.2.3        exactly that version
    >1.2.3 >=1.2.3 <1.2.3 <=1.2.3
    1.x  1.2.*  *  ""    x-ranges: 1.x := >=1.0.0 <2.0.0, 1.2.* := >=1.2.0 <1.3.0
    ~1.2.3               >=1.2.3 <1.3.0   (~1.2 := >=1.2.0 <1.3.0, ~1 := >=1.0.0 <2.0.0)
    ^1.2.3               >=1.2.3 <2.0.0   (^0.2.3 := >=0.2.3 <0.3.0, ^0.0.3 := >=0.0.3 <0.0.4,
                                           ^1.x := >=1.0.0 <2.0.0, ^0.x := >=0.0.0 <1.0.0)
    partial comparisons  >=1.2 := >=1.2.0, <1.2 := <1.2.0, >1.2 := >=1.3.0, <=1.2 := <1.3.0
A version with a prerelease satisfies a set only if it satisfies every comparator AND some
comparator of that set has a prerelease on the same MAJOR.MINOR.PATCH ("^1.2.3-beta.1" admits
1.2.3-beta.4 but not 1.3.0-beta.1; "^1.2.0" admits no prerelease at all).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import total_ordering

_ID = r"(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
_VERSION_RE = re.compile(
    rf"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-({_ID}(?:\.{_ID})*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
_PARTIAL_RE = re.compile(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
_OPS = (">=", "<=", ">", "<", "=")


@total_ordering
@dataclass(frozen=True, eq=False)
class Version:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...] = ()
    build: tuple[str, ...] = ()

    def _key(self) -> tuple:
        pre = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in self.prerelease)
        return (self.major, self.minor, self.patch, 0 if self.prerelease else 1, pre)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Version) and self._key() == other._key()

    def __hash__(self) -> int:
        return hash(self._key())

    def __lt__(self, other: "Version") -> bool:
        return self._key() < other._key()

    def __str__(self) -> str:
        text = f"{self.major}.{self.minor}.{self.patch}"
        text += "-" + ".".join(self.prerelease) if self.prerelease else ""
        return text + ("+" + ".".join(self.build) if self.build else "")


def parse(text: str) -> Version:
    m = _VERSION_RE.match(text.strip()) if isinstance(text, str) else None
    if not m:
        raise ValueError(f"invalid version: {text!r}")
    pre = tuple(m.group(4).split(".")) if m.group(4) else ()
    build = tuple(m.group(5).split(".")) if m.group(5) else ()
    return Version(int(m.group(1)), int(m.group(2)), int(m.group(3)), pre, build)


def _partial(text: str) -> tuple[list, tuple[str, ...]]:
    m = _PARTIAL_RE.match(text)
    if not m:
        raise ValueError(f"invalid version in range: {text!r}")
    parts = [None if g is None or g in "xX*" else int(g) for g in m.group(1, 2, 3)]
    for i in range(3):
        if parts[i] is None:
            parts[i:] = [None] * (3 - i)
            break
    pre = tuple(m.group(4).split(".")) if m.group(4) and parts[2] is not None else ()
    return parts, pre


def _desugar(token: str) -> list[tuple[str, Version]]:
    anything = [(">=", Version(0, 0, 0))]
    op = token[0] if token[:1] in ("^", "~") else next((o for o in _OPS if token.startswith(o)), "")
    (major, minor, patch), pre = _partial(token[len(op):])
    if major is None:
        return [("<", Version(0, 0, 0, ("0",)))] if op in (">", "<") else anything
    lo = Version(major, minor or 0, patch or 0, pre)
    if op == "^":
        if major > 0 or minor is None:
            hi = Version(major + 1, 0, 0)
        elif minor > 0 or patch is None:
            hi = Version(0, minor + 1, 0)
        else:
            hi = Version(0, 0, patch + 1)
        return [(">=", lo), ("<", hi)]
    hi = Version(major + 1, 0, 0) if minor is None else Version(major, minor + 1, 0)
    if op == "~":
        return [(">=", lo), ("<", hi)]
    if patch is not None:
        return [(op or "=", lo)]
    return {"": [(">=", lo), ("<", hi)], "=": [(">=", lo), ("<", hi)], ">=": [(">=", lo)],
            ">": [(">=", hi)], "<": [("<", lo)], "<=": [("<", hi)]}[op]


def parse_range(text: str) -> list[list[tuple[str, Version]]]:
    sets = []
    for chunk in text.split("||"):
        tokens, comps = chunk.split(), []
        while tokens:
            tok = tokens.pop(0)
            if tok in _OPS + ("^", "~") and tokens:
                tok += tokens.pop(0)
            comps.extend(_desugar(tok))
        sets.append(comps or [(">=", Version(0, 0, 0))])
    return sets


def _test(op: str, v: Version, c: Version) -> bool:
    return {"=": v == c, ">": v > c, ">=": v >= c, "<": v < c, "<=": v <= c}[op]


def satisfies(version: str | Version, range_text: str) -> bool:
    v = parse(version) if isinstance(version, str) else version
    for comps in parse_range(range_text):
        if all(_test(op, v, c) for op, c in comps):
            if not v.prerelease or any(
                c.prerelease and (c.major, c.minor, c.patch) == (v.major, v.minor, v.patch) for _, c in comps
            ):
                return True
    return False


def sort_versions(versions: list[str]) -> list[str]:
    """Ascending by precedence; versions of equal precedence keep their input order."""
    return sorted(versions, key=parse)


def max_satisfying(versions: list[str], range_text: str) -> str | None:
    """The highest version (as given) that satisfies the range, or None."""
    best = None
    for text in versions:
        if satisfies(text, range_text) and (best is None or parse(text) > parse(best)):
            best = text
    return best
