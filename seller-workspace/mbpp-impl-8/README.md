# humanevalfix-8

A coding-repair RL environment built from third-party open-source content: 8 bug-repair tasks from
**HumanEvalFix** (the Python split of [bigcode/humanevalpack](https://huggingface.co/datasets/bigcode/humanevalpack),
MIT, dataset revision `9a41762f73a8cb23bb5811b73d5aab164efcf378`), converted to the py-repair-kit
episode format. Each task starts with one buggy function in package `hefix`. The agent is told that
one of the docstring examples fails, and it fixes the function through the same five-action protocol
as py-repair-kit. The upstream HumanEvalPack test function, run as a hidden pytest test, grades the
result.

The grader (`grader/`) is py-repair-kit's grader, copied unchanged except for the environment
version string, temp-dir prefixes and docstring examples. The layout, CLI and JSON-lines protocol
are identical, so the packager, TEE runner and buyer agent work with no changes.

## Layout

| Path | Delivered to buyer? | Contents |
|---|---|---|
| `src/` | yes | `hefix/`: the correct (canonical) function for each purchased task, one module each, plus a README with the MIT notice |
| `tasks/T1..T8/` | yes | Purchased tasks: `task.json` (with an `upstream` block), `overlay/` (buggy module), `visible_tests/`, `tests/` (hidden) |
| `solutions/T1..T8/` | yes | Canonical modules, laid out in the overlay format |
| `grader/` | yes | `env.py` (reset/step/grade/close CLI and `serve`), `grade.py`, `tasks.py` |
| `requirements.lock` | yes | pytest 8.3.5 and its dependencies, sha256-pinned (used only for grading) |
| `Dockerfile.runner`, `scripts/` | yes | Offline runtime image, `verify.sh`, `verify_tasks.py`, `build-image.sh`, `build_from_upstream.py` |
| `LICENSE-ENV.md`, `provenance.json`, `listing/` | yes (public docs) | License (upstream MIT + seller terms), provenance with task mapping, description, manifest template |
| `IMAGE_DIGEST` | yes | Written by `scripts/build-image.sh` |
| `audit-tasks/A1..A2/` | **never** | Audit holdout in the same format, with `solution/` inside each task. Their modules are not in `src/`: the overlay adds them, so no audit content ships with the bundle |

## Conversion (per HumanEvalPack row)

| Episode file | Built from |
|---|---|
| `overlay/hefix/<entry_point>.py` | `prompt` (imports, signature, docstring) + `buggy_solution` |
| `src/hefix/<entry_point>.py`, `solutions/<id>/hefix/<entry_point>.py` | `prompt` + `canonical_solution` |
| `tests/test_hidden.py` | `test`, unchanged except that the trailing `check(<entry_point>)` call becomes one pytest test (`test_upstream_check`) |
| `visible_tests/test_visible.py` | 1–2 asserts from `example_test` (the docstring examples): the first example, plus the first one that fails on the buggy code |
| `task.json` `statement` | Generated: names the function and quotes the failing docstring example. Does not reveal the upstream bug type |

Each module also gets a 2-line header comment pointing to the MIT notices. `scripts/build_from_upstream.py`
runs the conversion and the selection. It downloads the pinned parquet file, checks its sha256,
applies eligibility rules E1–E6 (see the script docstring; 132 of 164 rows are eligible), then draws
`random.Random(20260910).sample(eligible, 10)`: the first 8 become purchased tasks, the last 2 audit
tasks. Rerunning it reproduces these files byte for byte. It needs network access and `pyarrow`, but
only at build time.

| Task | Upstream | Function | Upstream bug type |
|---|---|---|---|
| T1 | Python/3 (HumanEval/3) | `below_zero` | operator misuse |
| T2 | Python/20 | `find_closest_elements` | operator misuse |
| T3 | Python/31 | `is_prime` | value misuse |
| T4 | Python/46 | `fib4` | value misuse |
| T5 | Python/74 | `total_match` | variable misuse |
| T6 | Python/75 | `is_multiply_prime` | value misuse |
| T7 | Python/107 | `even_odd_palindrome` | value misuse |
| T8 | Python/112 | `reverse_delete` | operator misuse |
| A1 (audit) | Python/24 | `largest_divisor` | operator misuse |
| A2 (audit) | Python/49 | `modp` | value misuse |

## Environment CLI

The CLI is the same as py-repair-kit's. Run commands from the bundle root. Each prints exactly one JSON line.

```bash
python -m grader.env reset T1 --seed 0 --workdir /tmp/ep1
python -m grader.env step --workdir /tmp/ep1 --action '{"type":"read_file","path":"hefix/below_zero.py"}'
python -m grader.env grade --workdir /tmp/ep1
python -m grader.env close --workdir /tmp/ep1
python -m grader.env serve          # JSON lines: {"id":1,"cmd":"reset","taskId":"T1","seed":0,"workdir":"/tmp/ep1"}
python -m grader.grade --task T1 --workspace /tmp/ep1/workspace
```

## Verify

```bash
PYTHON=/path/to/python3.12 scripts/verify.sh   # native (Python 3.12 + pytest 8.3.5)
scripts/verify.sh --docker                      # --network none --read-only, 1 CPU / 512 MB / 128 pids
```
