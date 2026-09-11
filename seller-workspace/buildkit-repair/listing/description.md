# buildkit-repair

Six issue-style repair tasks on **buildkit**, a small stdlib-only Python 3.12 library of build-tool
helpers: semver ranges, dependency ordering, path globs, JSON Pointer, cron schedules and layered
config. The seller wrote it for this listing. In each episode an agent reads files, edits a library
module, runs a visible test and submits. A hidden pytest suite grades the final workspace offline
and deterministically.

The numbered claims below mirror `description.json`, which is the hashed, authoritative version.

## Claims

1. **C1 Task count.** Exactly 6 purchased tasks (T1–T6). A separate set of 2 seller-supplied audit
   tasks (A1, A2) is disclosed. It is not delivered and not counted in the 6.
2. **C2 Authorship.** The seller wrote everything for this listing; the environment was created on
   2026-09-11. Nothing is copied from or derived from a dataset, benchmark or third-party project.
3. **C3 Skills.** T1 `semver.py` prerelease precedence; T2 `graph.py` topological-sort
   tie-breaking; T3 `globmatch.py` `**` semantics; T4 `jsonpointer.py` RFC 6901 escaping; T5
   `cron.py` next-run search across day boundaries; T6 `config.py` deep merge without shared state.
4. **C4 Difficulty.** 2 easy (T1, T4), 3 medium (T2, T3, T6), 1 hard (T5). Audit: A1 easy, A2
   medium. These are the seller's labels.
5. **C5 Task design.** One injected defect per task, delivered by overlaying one module. Starting
   state and reference solution differ only in that module, by at most 9 diff lines. Statements are
   bug reports with a short repro and do not state the fix.
6. **C6 Test coverage.** Hidden tests: T1 10, T2 11, T3 9, T4 10, T5 11, T6 11 (62 total); A1 8,
   A2 8. On the starting state 4–8 hidden tests fail per purchased task. Each task has 1–2 visible
   tests, and at least one fails on the starting state.
7. **C7 Dependencies.** `buildkit` and the driver use only the stdlib. The tests use pytest 8.3.5,
   pluggy 1.6.0, iniconfig 2.3.0 and packaging 26.3, all sha256-pinned.
8. **C8 Runtime.** CPython 3.12. The image is built on
   `python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea` and runs
   as a non-root user. No GPU.
9. **C9 Network.** Offline at run time (`scripts/verify.sh --docker` uses `--network none`).
10. **C10 Determinism.** No module or test reads the clock or uses randomness; `cron.next_run` takes
    `now` as an argument. The grader reads the clock only for the episode time budget. Re-grading
    the same workspace gives the same result.
11. **C11 Budgets.** 12 tool actions plus a free submit, and 600 s per episode. Visible tests time out
    after 60 s and grading after 120 s. Running out of budget or time scores 0.
12. **C12 Validity.** On every starting state a hidden test and a visible test fail. With the
    reference solution, all tests pass.
13. **C13 Isolation.** Hidden tests never enter the workspace. Only `buildkit/*.py` is copied back for
    grading.
14. **C14 Delivery.** `src/buildkit`, all 6 tasks, the solutions, the grader and driver, the lockfile,
    the Dockerfile, `IMAGE_DIGEST` and the verification scripts. Audit modules and solutions are not
    in the bundle.
15. **C15 Resources.** 1 CPU, 512 MB, 128 pids, read-only root filesystem, 256 MB tmpfs.
16. **C16 Size.** `src/buildkit` has 6 modules plus `__init__.py`, under 700 lines; no module over
    160 lines.
17. **C17 License.** Non-exclusive internal training and evaluation. Redistribution needs written
    permission (`LICENSE-ENV.md`).
18. **C18 Provenance.** No upstream sources, copied code or copied issue text. Third-party components
    are pytest and its dependencies plus the base image, unmodified. Behaviour follows public specs
    (SemVer 2.0.0, npm ranges, RFC 6901); T4's hidden tests use the RFC 6901 example document. No
    funders or related parties.

## Not claimed

No claim is made that training on these tasks improves model performance. Difficulty labels are
the seller's judgment. No claim is made that the hidden tests catch every incorrect fix. The topics
are widely documented, even though this code, these reports and these tests are new. No claim that
the source has never been visible outside the market; only that it is seller-written and not
derived from any dataset.
