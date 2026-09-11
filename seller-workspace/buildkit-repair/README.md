# buildkit-repair

A coding-repair RL environment. Each task starts from a buggy state of **buildkit**, a small
stdlib-only Python 3.12 library with the helpers a build tool or package manager needs (semver
ranges, dependency ordering, path globs, JSON Pointer, cron schedules, layered config), plus a bug
report written as a user issue. The agent edits the library through a small action set, and a
hidden pytest suite grades the result.

The seller wrote everything here for this listing on 2026-09-11. No dataset, benchmark or
third-party project was used as a source.

The grader (`grader/`) is py-repair-kit's grader, copied unchanged except for the environment
version string, temp-dir prefixes and docstring examples. The layout, CLI and JSON-lines protocol
are identical, so the packager, TEE runner and buyer agent work with no changes.

## Layout

| Path | Delivered to buyer? | Contents |
|---|---|---|
| `src/` | yes | The correct reference library (`buildkit/`, 6 modules plus `__init__.py`) and its README |
| `tasks/T1..T6/` | yes | Purchased tasks: `task.json`, `overlay/` (buggy module), `visible_tests/`, `tests/` (hidden) |
| `solutions/T1..T6/` | yes | Reference fixes, laid out in the overlay format |
| `grader/` | yes | `env.py` (reset/step/grade/close CLI and `serve`), `grade.py`, `tasks.py` |
| `requirements.lock` | yes | pytest 8.3.5 and its dependencies, sha256-pinned (used only for grading) |
| `Dockerfile.runner`, `scripts/` | yes | Offline runtime image, `verify.sh`, `verify_tasks.py`, `build-image.sh` |
| `LICENSE-ENV.md`, `provenance.json`, `listing/` | yes (public docs) | License, provenance, description, manifest template |
| `IMAGE_DIGEST` | yes | Written by `scripts/build-image.sh` |
| `audit-tasks/A1..A2/` | **never** | Audit holdout in the same format, with `solution/` inside each task. Their modules (`buildkit/dotenv.py`, `buildkit/resolve.py`) are not in `src/`: the overlay adds them, so no audit content ships with the bundle |

## Tasks

| Task | Module | Difficulty | Report |
|---|---|---|---|
| T1 | `semver.py` | easy | `max_satisfying()` picks rc.9 over rc.10 |
| T2 | `graph.py` | medium | `topo_order()` does not follow its documented tie-break rule |
| T3 | `globmatch.py` | medium | `src/**/*.py` misses files directly under `src/` |
| T4 | `jsonpointer.py` | easy | Lockfile lookups fail for keys containing `~1` |
| T5 | `cron.py` | hard | Weekly jobs sometimes skip a whole week |
| T6 | `config.py` | medium | Staging overrides leak into the prod config |
| A1 (audit) | `dotenv.py` (audit only) | easy | Values containing `#` come back empty or cut off |
| A2 (audit) | `resolve.py` (audit only) | medium | `resolve()` picks a version that one requirement rejects |

Each starting state is the correct module with one defect injected via `overlay/`. The statement
gives the symptom and a short repro, not the fix.

## Starting-state mechanism: overlay

A task's starting workspace is a copy of `src/` with every file in `tasks/<id>/overlay/` copied on top
of it at the same relative path. The agent workspace also gets `visible_tests/` and a generated
`pytest.ini`. Hidden tests (`tasks/<id>/tests/`) never enter the agent workspace. At grading time,
`grader/grade.py` rebuilds the starting state in a fresh temp dir, copies in only the workspace files
that match `buildkit/*.py` (excluding `conftest.py`), adds the hidden tests and runs pytest in a
subprocess with a timeout.

## Environment CLI

Run commands from the bundle root. Each prints exactly one JSON line.

```bash
python -m grader.env reset T1 --seed 0 --workdir /tmp/ep1
python -m grader.env step --workdir /tmp/ep1 --action '{"type":"read_file","path":"buildkit/semver.py"}'
python -m grader.env grade --workdir /tmp/ep1
python -m grader.env close --workdir /tmp/ep1
python -m grader.env serve          # JSON lines: {"id":1,"cmd":"reset","taskId":"T1","seed":0,"workdir":"/tmp/ep1"}
python -m grader.grade --task T1 --workspace /tmp/ep1/workspace
```

## Verify

```bash
PYTHON=/path/to/python3.12 scripts/verify.sh   # native (Python 3.12 + pytest 8.3.5)
scripts/build-image.sh                          # build the runner image, write IMAGE_DIGEST
scripts/verify.sh --docker                      # --network none --read-only, 1 CPU / 512 MB / 128 pids
```
