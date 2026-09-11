"""Path glob matching for build inputs (include / exclude lists).

Paths and patterns are relative POSIX paths such as "src/app/main.py". A pattern must match the
whole path. Matching is case-sensitive and dotfiles get no special treatment.

    ?        any one character except "/"
    *        any run of characters, possibly empty, except "/"
    **       when it is a whole path segment: any number of whole segments, including none.
             "src/**/*.py" matches "src/a.py" and "src/a/b/c.py"; "**/test_*.py" matches
             "test_x.py" and "pkg/test_x.py"; "build/**" matches every path under build/ (but
             not "build" itself). Anywhere else ("a**b") it behaves like "*".
    [abc]    one character from the set; ranges like [a-z]; [!abc] negates the set. A class never
             matches "/". A "]" right after "[" or "[!" is literal; a "[" without a closing "]"
             is a literal "[".
    anything else matches itself. There is no escape character.

select(paths, include, exclude=()) keeps the paths that match at least one include pattern and no
exclude pattern, in their original order.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from functools import lru_cache


def _segment(seg: str) -> str:
    out, i, n = [], 0, len(seg)
    while i < n:
        c = seg[i]
        if c == "*":
            while i < n and seg[i] == "*":
                i += 1
            out.append("[^/]*")
            continue
        if c == "?":
            out.append("[^/]")
        elif c == "[":
            j = i + 1
            if j < n and seg[j] == "!":
                j += 1
            if j < n and seg[j] == "]":
                j += 1
            while j < n and seg[j] != "]":
                j += 1
            if j >= n:
                out.append(re.escape(c))
            else:
                body = seg[i + 1:j]
                negate = body.startswith("!")
                body = "".join("\\" + ch if ch in "\\^[]" else ch for ch in (body[1:] if negate else body))
                out.append("(?!/)[" + ("^" if negate else "") + body + "]")
                i = j
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


@lru_cache(maxsize=512)
def compile_pattern(pattern: str) -> re.Pattern[str]:
    segs = pattern.split("/")
    rx = ""
    for idx, seg in enumerate(segs):
        last = idx == len(segs) - 1
        if seg == "**":
            rx += ".+" if last else "(?:[^/]+/)*"
        else:
            rx += _segment(seg) + ("" if last else "/")
    return re.compile(rx, re.DOTALL)


def match(pattern: str, path: str) -> bool:
    return compile_pattern(pattern).fullmatch(path) is not None


def select(paths: Iterable[str], include: Iterable[str], exclude: Iterable[str] = ()) -> list[str]:
    include, exclude = list(include), list(exclude)
    return [
        p for p in paths
        if any(match(i, p) for i in include) and not any(match(e, p) for e in exclude)
    ]
