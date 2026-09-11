# py-repair-kit

This is a coding-repair RL environment. Each task starts from a buggy state of **ledgerlite**, a small
stdlib-only Python 3.12 bookkeeping library, plus an issue-style bug report. The agent edits the
library through a small action set, and a hidden pytest suite grades the result.

## Layout

| Path | Delivered to buyer? | Contents |
|---|---|---|
| `src/` | yes | The correct reference library (`ledgerlite/`, 8 modules plus `__init__.py`) and its README |
| `tasks/T1..T5/` | yes | Purchased tasks: `task.json`, `overlay/`, `visible_tests/`, `tests/` (hidden) |
| `solutions/T1..T5/` | yes | Reference fixes, laid out in the same overlay format |
| `grader/` | yes | `env.py` (reset/step/grade/close CLI), `grade.py` (hidden-test grader), `tasks.py` |
| `requirements.lock` | yes | pytest 8.3.5 + deps, sha256-pinned (grading only) |
| `Dockerfile.runner`, `scripts/` | yes | Offline runtime image, `verify.sh`, `verify_tasks.py`, `build-image.sh` |
| `LICENSE-ENV.md`, `provenance.json`, `listing/` | yes (public docs) | License, provenance, description, manifest template |
| `IMAGE_DIGEST` | yes | Written by `scripts/build-image.sh` |
| `audit-tasks/A1..A2/` | **never** | Audit holdout in the same format, with `solution/` inside each task |

## Starting-state mechanism: overlay

A task's starting workspace is a copy of `src/` with every file in `tasks/<id>/overlay/` copied on top
of it at the same relative path. The agent workspace also gets `visible_tests/` and a generated
`pytest.ini`. Hidden tests (`tasks/<id>/tests/`) are never placed in the agent workspace. A reference
solution (`solutions/<id>/`, or `audit-tasks/<id>/solution/`) uses the same format and is applied the
same way.

At grading time, `grader/grade.py` rebuilds the starting state in a fresh temp dir. It copies in only
the workspace files that match the task's `editableFiles` patterns (`ledgerlite/*.py`, excluding
`conftest.py`), adds the hidden tests and runs pytest in a subprocess with a timeout.

## Environment CLI

Run all commands from the bundle root. Each prints exactly one JSON line. See the `grader/env.py`
docstring for details.

```bash
python -m grader.env reset T1 --seed 0 --workdir /tmp/ep1
python -m grader.env step --workdir /tmp/ep1 --action '{"type":"read_file","path":"ledgerlite/lru.py"}'
python -m grader.env grade --workdir /tmp/ep1
python -m grader.env close --workdir /tmp/ep1
python -m grader.env serve          # JSON lines: {"id":1,"cmd":"reset","taskId":"T1","seed":0,"workdir":"/tmp/ep1"}
python -m grader.grade --task T1 --workspace /tmp/ep1/workspace   # grade an artifact directly
```

## Verify

```bash
PYTHON=/path/to/python3.12 scripts/verify.sh   # native
scripts/verify.sh --docker                      # --network none --read-only, 1 CPU / 512 MB / 128 pids
```
