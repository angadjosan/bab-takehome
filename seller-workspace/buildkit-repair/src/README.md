# buildkit

Small helpers for a build tool or package manager. Python 3.12, standard library only. Each
module's docstring is its specification.

| Module | What it does |
|---|---|
| `buildkit/semver.py` | Parse Semantic Versioning 2.0.0 versions, order them (prerelease rules included), match npm-style ranges (`^`, `~`, comparisons, x-ranges, `\|\|`), pick the highest satisfying version |
| `buildkit/graph.py` | Topological order of a dependency graph with deterministic tie-breaking, parallel build levels, affected targets, cycle detection that reports the cycle |
| `buildkit/globmatch.py` | Match relative POSIX paths against globs with `*`, `**`, `?` and `[...]`; include/exclude selection |
| `buildkit/jsonpointer.py` | RFC 6901 JSON Pointer parse, escape, get and set, including `~0`/`~1` and the `-` array index |
| `buildkit/cron.py` | Next run time of a 5-field cron expression (lists, ranges, steps, day-of-month/day-of-week OR rule). `now` is always passed in; the module never reads the clock |
| `buildkit/config.py` | Layered config: deep merge with precedence (dicts merge, lists and scalars replace), `${VAR}` / `${VAR:-default}` / `$$` interpolation from a passed-in mapping |

`buildkit/__init__.py` does not import the submodules; import them directly.

```python
from datetime import datetime
from buildkit.semver import max_satisfying
from buildkit.cron import next_run

max_satisfying(["1.4.2", "1.9.0", "2.0.0"], "^1.4.0")        # '1.9.0'
next_run("0 9 * * 1-5", datetime(2026, 9, 11, 18, 0))          # datetime(2026, 9, 14, 9, 0)
```
