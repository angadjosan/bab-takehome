# py-repair-kit

Five issue-style Python repair tasks on **ledgerlite**, a small bookkeeping library that uses only the
Python 3.12 standard library. In each episode an agent reads files, edits library modules, runs one
visible test and submits. A hidden pytest suite grades the final workspace offline and deterministically.

The numbered claims below mirror `description.json`, which is the hashed, authoritative version.

## Claims

1. **C1 Task count.** Exactly 5 purchased tasks (T1–T5). A separate set of 2 seller-supplied audit
   tasks is disclosed. It is not delivered and not counted in the 5.
2. **C2 Skills.** T1: data-structure invariants (LRU recency). T2: text ingestion robustness
   (encodings, CSV headers). T3: exact decimal arithmetic (cent allocation). T4: time-based algorithms
   (token-bucket rate limiting with an injected clock). T5: timezone- and boundary-correct period logic
   across two modules.
3. **C3 Difficulty.** Seller-assigned labels: 2 easy (T1, T2), 2 medium (T3, T4), 1 hard (T5, which
   needs changes in two modules).
4. **C4 Dependencies.** The library and the environment driver are stdlib-only. The only third-party
   packages, used just to run tests, are pytest 8.3.5, pluggy 1.6.0, iniconfig 2.3.0 and packaging 26.3.
   `requirements.lock` pins them with sha256 hashes.
5. **C5 Runtime.** CPython 3.12. The runner image is built on
   `python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea` and runs
   as a non-root user. No GPU.
6. **C6 Network.** Fully offline. `scripts/verify.sh --docker` runs everything with `--network none`.
7. **C7 Determinism.** No randomness. The seed is recorded but ignored, tests use fake clocks, and
   grading runs with `PYTHONHASHSEED=0` and `TZ=UTC`. Re-grading the same workspace gives the same result.
8. **C8 Budgets.** 12 tool actions plus a free submit, and 600 s of wall-clock time per episode.
   Visible tests time out after 60 s and grading after 120 s. An episode that runs out of budget or
   time scores 0.
9. **C9 Validity.** On every purchased task's starting state, at least one hidden test fails. With the
   reference solution, all hidden tests pass.
10. **C10 Test coverage.** Every purchased task's hidden suite contains at least 8 pytest-collected
    test cases.
11. **C11 Isolation.** Visible and hidden tests are separate. Hidden tests never enter the agent
    workspace. Grading copies back only editable files (`ledgerlite/*.py`, excluding `conftest.py`).
12. **C12 Delivery.** Delivery includes the library source, all 5 tasks (statement, overlay, visible
    and hidden tests), reference solutions in `solutions/`, the grader and driver, the lockfile, the
    Dockerfile and the verification scripts.
13. **C13 Resources.** Runs within 1 CPU, 512 MB of memory and 128 processes, with a read-only root
    filesystem and a 256 MB tmpfs.
14. **C14 Size.** `src/ledgerlite` has 8 modules plus `__init__.py`, under 1,000 lines in total.
15. **C15 License.** Non-exclusive internal training and evaluation. No redistribution without
    permission (`LICENSE-ENV.md`).
16. **C16 Provenance.** Synthetic, written by the seller for this listing. No upstream code and no
    funders or related parties.

## Not claimed

No claim is made that training on these tasks improves model performance. Difficulty labels are the
seller's judgment.

## Interface

The coding adapter follows manifest schema "1". The entrypoints are `reset(taskId, seed)`, `step(action)`
with the actions `list_files`, `read_file`, `write_file`, `run_visible_tests` and `submit`,
`grade(workspace)` and `close()`. They are exposed as `python -m grader.env …`, either as one-shot
JSON commands or as a JSON-lines server.
