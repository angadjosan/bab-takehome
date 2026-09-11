# humanevalfix-8

Eight single-function Python bug-repair tasks from **HumanEvalFix** (bigcode/humanevalpack, Python
split, MIT), converted to the py-repair-kit episode format. In each episode an agent reads files,
fixes one buggy function against its docstring, runs a visible test and submits. The upstream
HumanEvalPack test function, run as a hidden pytest test, grades the final workspace offline and
deterministically.

The numbered claims below mirror `description.json`, which is the hashed, authoritative version.

## Claims

1. **C1 Task count.** Exactly 8 purchased tasks (T1–T8). A separate set of 2 audit tasks is disclosed.
   It is not delivered and not counted in the 8.
2. **C2 Source.** Each task comes from one HumanEvalPack row (config `python`, split `test`, revision
   `9a41762f73a8cb23bb5811b73d5aab164efcf378`): T1 Python/3 `below_zero`, T2 Python/20
   `find_closest_elements`, T3 Python/31 `is_prime`, T4 Python/46 `fib4`, T5 Python/74 `total_match`,
   T6 Python/75 `is_multiply_prime`, T7 Python/107 `even_odd_palindrome`, T8 Python/112
   `reverse_delete`. Python/N is HumanEval/N.
3. **C3 Conversion.** Starting state = upstream `prompt` + `buggy_solution`. Reference solution =
   `prompt` + `canonical_solution`. Hidden test = the upstream `test`, with the trailing `check(...)`
   call turned into one pytest test. Visible test = 1–2 asserts from the upstream `example_test`. The
   only other change to upstream code is a 2-line header comment per module.
4. **C4 Selection.** Mechanical. Rules E1–E6 leave 132 of 164 rows, and `random.Random(20260910)`
   draws 10 (8 purchased, 2 audit). `scripts/build_from_upstream.py` reproduces the files byte for byte
   from a sha256-checked download.
5. **C5 Skills.** Single-function repair against a docstring. Upstream bug types: operator misuse (T1,
   T2, T8), value misuse (T3, T4, T6, T7), variable misuse (T5). Each fix changes 1–2 lines. The
   statement quotes one failing docstring example and does not reveal the bug type.
6. **C6 Difficulty.** Every task carries the seller label "easy".
7. **C7 Test coverage.** Each hidden suite is one pytest test (the upstream `check`) with 4–13 asserts.
   Each visible test has 1–2 asserts.
8. **C8 Dependencies.** `hefix` and the driver use only the stdlib. The tests use pytest 8.3.5, pluggy
   1.6.0, iniconfig 2.3.0 and packaging 26.3, all sha256-pinned.
9. **C9 Runtime.** CPython 3.12. The image is built on
   `python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea` and runs
   as a non-root user. No GPU.
10. **C10 Network.** Offline at run time (`scripts/verify.sh --docker` uses `--network none`).
11. **C11 Determinism.** No randomness and no clock reads. Upstream tests that use `random` were
    excluded. Re-grading the same workspace gives the same result.
12. **C12 Budgets.** 12 tool actions plus a free submit, and 600 s per episode. Visible tests time out
    after 60 s and grading after 120 s. Running out of budget or time scores 0.
13. **C13 Validity.** On the starting state the hidden test fails and a visible assert fails. With the
    reference solution, both pass.
14. **C14 Isolation.** Hidden tests never enter the workspace. Only `hefix/*.py` is copied back for
    grading.
15. **C15 Delivery.** `src/hefix`, all 8 tasks, the solutions, the grader and driver, the lockfile, the
    Dockerfile, the verification scripts and the conversion script.
16. **C16 Resources.** 1 CPU, 512 MB, 128 pids, read-only root filesystem, 256 MB tmpfs.
17. **C17 Size.** `src/hefix` has 8 modules plus `__init__.py`, under 300 lines.
18. **C18 License.** Upstream material stays MIT and is not restricted, and its notices are included.
    The seller's additions are licensed non-exclusively for internal use (`LICENSE-ENV.md`).
19. **C19 Provenance.** The upstream content is public and free. This listing adds the conversion,
    grader, verification and packaging. No funders, no related parties, no conflicts.

## Not claimed

No claim is made that training on these tasks improves model performance. No claim of novelty or
freedom from contamination: HumanEval and HumanEvalPack are public, and models may have trained on
them. Difficulty labels are the seller's judgment. No claim is made that the upstream tests catch
every incorrect fix.
