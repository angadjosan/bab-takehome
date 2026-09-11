"""Rebuild src/, tasks/, audit-tasks/, solutions/ and provenance.json from HumanEvalPack (Python).

Build-time only (needs network and pyarrow; the environment itself is offline and stdlib-only):

    python3.12 -m venv /tmp/hefix-build && /tmp/hefix-build/bin/pip install pyarrow
    /tmp/hefix-build/bin/python scripts/build_from_upstream.py [--cache DIR]

Source: https://huggingface.co/datasets/bigcode/humanevalpack (MIT), config "python", split "test",
file python/test-00000-of-00001.parquet at the pinned dataset revision REVISION. The file's sha256 is
checked against PARQUET_SHA256, so a rebuild gives the same output bytes or fails.

Eligibility (every rule is mechanical and applied to all 164 rows in upstream order):
  E1  failure_symptoms == "incorrect output" (excludes the 4 infinite-loop / stack-overflow bugs)
  E2  the hidden test does not use the `random` module (keeps grading deterministic)
  E3  example_test is a check() function made only of assert statements
  E4  prompt + canonical_solution passes the full upstream test and every example assert
  E5  prompt + buggy_solution fails the full upstream test, and fails at least one example assert
      (so the visible test fails on the starting state, as scripts/verify_tasks.py requires)
  E6  entry_point is a lowercase identifier, usable as the module name hefix/<entry_point>.py
Selection: random.Random(SEED).sample(eligible, 10). The first 8 are the purchased tasks, the last 2
the audit tasks. Within each group, ids are assigned in ascending upstream order (T1..T8, A1..A2).
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import random
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
DATASET = "bigcode/humanevalpack"
REVISION = "9a41762f73a8cb23bb5811b73d5aab164efcf378"
PARQUET_PATH = "python/test-00000-of-00001.parquet"
PARQUET_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/{PARQUET_PATH}"
PARQUET_SHA256 = "ed5f15d789156e21222bfcd556c425a39042355c84ae1e8b058abd6a3d7f8075"
SEED = 20260910
N_PURCHASED, N_AUDIT = 8, 2
PKG = "hefix"
ENVIRONMENT_VERSION = "humanevalfix-8@1.0.0"
CHECK_TIMEOUT_SEC = 20

MODULE_HEADER = (
    "# Adapted from HumanEvalPack (bigcode/humanevalpack, MIT License), itself derived from\n"
    "# OpenAI HumanEval (MIT License). See README.md and LICENSE-ENV.md for the notices.\n\n"
)


def download(cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / f"humanevalpack-{REVISION[:12]}-python.parquet"
    if not dest.is_file() or hashlib.sha256(dest.read_bytes()).hexdigest() != PARQUET_SHA256:
        print(f"downloading {PARQUET_URL}")
        with urllib.request.urlopen(PARQUET_URL, timeout=120) as resp:
            dest.write_bytes(resp.read())
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if digest != PARQUET_SHA256:
        raise SystemExit(f"sha256 mismatch for {dest}: {digest} != {PARQUET_SHA256}")
    return dest


def load_rows(parquet: Path) -> list[dict]:
    import pyarrow.parquet as pq  # build-time dependency only

    return pq.read_table(parquet).to_pylist()


def example_asserts(example_test: str) -> tuple[str, list[str]] | None:
    """(check parameter name, [assert source, ...]) or None if example_test is not asserts-only."""
    try:
        tree = ast.parse(example_test)
    except SyntaxError:
        return None
    fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "check"]
    if len(fns) != 1 or len(fns[0].args.args) != 1:
        return None
    fn = fns[0]
    if not fn.body or not all(isinstance(s, ast.Assert) for s in fn.body):
        return None
    return fn.args.args[0].arg, [ast.get_source_segment(example_test, s) for s in fn.body]


_PROBE = r"""
import json, sys
mod_src, test_src, param, entry, asserts = json.loads(sys.stdin.read())
ns = {"__name__": "probe"}
exec(compile(mod_src, "module.py", "exec"), ns)
out = {"examples": []}
for a in asserts:
    local = dict(ns)
    try:
        exec(f"{param} = {entry}\n{a}", local)
        out["examples"].append(True)
    except BaseException:
        out["examples"].append(False)
try:
    exec(compile(test_src, "test.py", "exec"), dict(ns))
    out["full"] = True
except BaseException as exc:
    out["full"] = False
    out["fullError"] = type(exc).__name__
print(json.dumps(out))
"""


def probe(module_src: str, test_src: str, param: str, entry: str, asserts: list[str]) -> dict | None:
    try:
        run = subprocess.run(
            [sys.executable, "-c", _PROBE],
            input=json.dumps([module_src, test_src, param, entry, asserts]),
            capture_output=True, text=True, timeout=CHECK_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        return None
    if run.returncode != 0:
        return None
    return json.loads(run.stdout.strip().splitlines()[-1])


def module_source(row: dict, body: str) -> str:
    return MODULE_HEADER + row["prompt"] + body


def assert_count(test_src: str) -> int:
    return sum(isinstance(n, ast.Assert) for n in ast.walk(ast.parse(test_src)))


def strip_final_check_call(test_src: str, entry: str) -> str:
    lines = test_src.rstrip().splitlines()
    call = re.compile(rf"^check\(\s*{re.escape(entry)}\s*\)\s*$")
    if not lines or not call.match(lines[-1]):
        raise ValueError(f"unexpected test tail for {entry}: {lines[-1:]}")
    return "\n".join(lines[:-1]).strip("\n") + "\n"


def evaluate(row: dict) -> tuple[bool, str, dict]:
    entry = row["entry_point"]
    if row["failure_symptoms"] != "incorrect output":
        return False, "E1 failure_symptoms", {}
    if "random" in row["test"]:
        return False, "E2 random in test", {}
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", entry):
        return False, "E6 entry point not a module name", {}
    ex = example_asserts(row["example_test"])
    if ex is None:
        return False, "E3 example_test not asserts-only", {}
    param, asserts = ex
    good = probe(module_source(row, row["canonical_solution"]), row["test"], param, entry, asserts)
    if not good or not good["full"] or not all(good["examples"]):
        return False, "E4 canonical does not pass", {}
    bad = probe(module_source(row, row["buggy_solution"]), row["test"], param, entry, asserts)
    if bad is None:
        return False, "E5 buggy probe timed out or crashed", {}
    if bad["full"]:
        return False, "E5 buggy passes full test", {}
    failing = [i for i, ok in enumerate(bad["examples"]) if not ok]
    if not failing:
        return False, "E5 buggy passes every example", {}
    picks = sorted({0, failing[0]})
    return True, "eligible", {"param": param, "visible": [asserts[i] for i in picks], "failingExample": asserts[failing[0]],
                               "exampleCount": len(asserts)}


def upstream_num(task_id: str) -> int:
    return int(task_id.split("/")[1])


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def visible_test_src(entry: str, param: str, visible: list[str]) -> str:
    out = [
        '"""Visible tests: docstring examples from the upstream example_test (HumanEvalPack, MIT)."""',
        f"from {PKG}.{entry} import *  # noqa: F401,F403 (helpers the examples may use)",
        f"from {PKG}.{entry} import {entry}",
    ]
    if param != entry:
        out += ["", f"{param} = {entry}"]
    for i, a in enumerate(visible, 1):
        out += ["", "", f"def test_docstring_example_{i}():", f"    {a}"]
    return "\n".join(out) + "\n"


def hidden_test_src(row: dict) -> str:
    entry = row["entry_point"]
    body = strip_final_check_call(row["test"], entry)
    return (
        f'"""Hidden test: the upstream `test` field of {row["task_id"]} (HumanEvalPack, MIT), unchanged except that\n'
        f'the trailing module-level `check({entry})` call is replaced by the pytest test at the bottom."""\n'
        f"from {PKG}.{entry} import *  # noqa: F401,F403 (helpers the upstream test may use)\n"
        f"from {PKG}.{entry} import {entry}\n\n"
        f"{body}\n\n"
        f"def test_upstream_check():\n"
        f"    check({entry})\n"
    )


def task_spec(tid: str, set_name: str, row: dict, meta: dict) -> dict:
    entry = row["entry_point"]
    statement = (
        f"{PKG}.{entry}.{entry}() does not do what its docstring says. One of the docstring's own examples fails:\n\n"
        f"    {meta['failingExample']}\n\n"
        f"The docstring in {PKG}/{entry}.py is the specification. Fix the implementation so the function matches the "
        f"docstring for all valid inputs, not just this example. Keep the function name and signature unchanged. "
        f"Only files matching {PKG}/*.py are graded."
    )
    return {
        "taskId": tid,
        "set": set_name,
        "title": f"{entry}() disagrees with its docstring",
        "statement": statement,
        "targetSkill": "single-function bug repair against a docstring specification",
        "difficulty": "easy",
        "visibleTestCmd": "python -m pytest -q -p no:cacheprovider visible_tests",
        "editableFiles": [f"{PKG}/*.py"],
        "startingState": {"mechanism": "overlay", "base": "src/", "overlayDir": "overlay/"},
        "hiddenTestsDir": "tests/",
        "visibleTestsDir": "visible_tests/",
        "actionBudget": 12,
        "timeBudgetSec": 600,
        "gradeTimeoutSec": 120,
        "successRule": "all hidden tests pass",
        "upstream": {
            "dataset": DATASET,
            "revision": REVISION,
            "config": "python",
            "split": "test",
            "taskId": row["task_id"],
            "humanEvalId": "HumanEval/" + row["task_id"].split("/")[1],
            "entryPoint": entry,
            "bugType": row["bug_type"],
            "failureSymptoms": row["failure_symptoms"],
            "hiddenAssertCount": assert_count(row["test"]),
            "visibleExampleCount": len(meta["visible"]),
            "modified": "converted to repair-episode format",
        },
    }


MIT_TEXT = """Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
"""


def src_readme(purchased: list[dict]) -> str:
    rows = "\n".join(f"| `{PKG}/{t['entryPoint']}.py` | `{t['entryPoint']}` |" for t in purchased)
    return f"""# {PKG}

Small standalone Python 3.12 functions, one per module, standard library only. Each module's
docstring is the function's specification.

| Module | Function |
|---|---|
{rows}

## Upstream notice

These functions (signature, docstring and body) come from HumanEvalPack
(https://huggingface.co/datasets/bigcode/humanevalpack, MIT License), which extends OpenAI HumanEval
(https://github.com/openai/human-eval, MIT License). They are redistributed here under the MIT
License, with this notice:

HumanEval: Copyright (c) OpenAI (https://openai.com)
HumanEvalPack / OctoPack: Copyright (c) 2023 Muennighoff

{MIT_TEXT}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "hefix-cache"))
    args = ap.parse_args()
    rows = load_rows(download(Path(args.cache)))
    assert len(rows) == 164, len(rows)

    eligible, reasons = [], {}
    for row in rows:
        ok, why, meta = evaluate(row)
        reasons[why] = reasons.get(why, 0) + 1
        if ok:
            eligible.append((row, meta))
    print(f"eligible {len(eligible)}/164; {reasons}")
    picked = random.Random(SEED).sample(eligible, N_PURCHASED + N_AUDIT)
    purchased = sorted(picked[:N_PURCHASED], key=lambda rm: upstream_num(rm[0]["task_id"]))
    audit = sorted(picked[N_PURCHASED:], key=lambda rm: upstream_num(rm[0]["task_id"]))

    for d in ("src", "tasks", "audit-tasks", "solutions"):
        shutil.rmtree(KIT / d, ignore_errors=True)

    write(KIT / "src" / PKG / "__init__.py",
          '"""hefix: reference (correct) implementations of the purchased HumanEvalPack functions, one module each."""\n')
    task_map = []
    for set_name, group, prefix in (("purchased", purchased, "T"), ("audit", audit, "A")):
        for i, (row, meta) in enumerate(group, 1):
            tid = f"{prefix}{i}"
            entry = row["entry_point"]
            rel = f"{PKG}/{entry}.py"
            good = module_source(row, row["canonical_solution"])
            buggy = module_source(row, row["buggy_solution"])
            tdir = KIT / ("tasks" if set_name == "purchased" else "audit-tasks") / tid
            write(tdir / "task.json", json.dumps(task_spec(tid, set_name, row, meta), indent=2) + "\n")
            write(tdir / "overlay" / rel, buggy)
            write(tdir / "visible_tests" / "test_visible.py", visible_test_src(entry, meta["param"], meta["visible"]))
            write(tdir / "tests" / "test_hidden.py", hidden_test_src(row))
            if set_name == "purchased":
                write(KIT / "src" / rel, good)
                write(KIT / "solutions" / tid / rel, good)
            else:  # audit functions are not in src/: the overlay adds the module, so no audit content ships
                write(tdir / "solution" / rel, good)
            task_map.append({
                "taskId": tid, "set": set_name, "upstreamTaskId": row["task_id"],
                "humanEvalId": "HumanEval/" + row["task_id"].split("/")[1], "entryPoint": entry,
                "module": f"src/{rel}" if set_name == "purchased" else f"audit-tasks/{tid}/overlay/{rel}",
                "bugType": row["bug_type"], "hiddenAssertCount": assert_count(row["test"]),
            })
            print(f"{tid:<3} {row['task_id']:<11} {entry:<28} {row['bug_type']}")

    write(KIT / "src" / "README.md", src_readme([t for t in task_map if t["set"] == "purchased"]))
    prov = json.loads((KIT / "provenance.json").read_text()) if (KIT / "provenance.json").is_file() else {}
    prov.setdefault("type", "envmarket.provenance.v1")
    prov["environmentId"] = "humanevalfix-8"
    prov["environmentVersion"] = ENVIRONMENT_VERSION
    prov["selection"] = {
        "script": "scripts/build_from_upstream.py",
        "sourceFile": PARQUET_URL,
        "sourceFileSha256": PARQUET_SHA256,
        "eligibilityRules": ["E1 failure_symptoms == 'incorrect output'", "E2 hidden test does not use random",
                             "E3 example_test is asserts-only", "E4 canonical passes full test and all examples",
                             "E5 buggy fails full test and at least one example",
                             "E6 entry_point usable as a lowercase module name"],
        "eligibleCount": len(eligible),
        "rowsConsidered": len(rows),
        "exclusionCounts": {k: v for k, v in sorted(reasons.items()) if k != "eligible"},
        "method": f"random.Random({SEED}).sample(eligible_in_upstream_order, {N_PURCHASED + N_AUDIT}); first {N_PURCHASED} purchased, last {N_AUDIT} audit; ids assigned in ascending upstream order within each group",
        "seed": SEED,
        "pythonVersionUsed": sys.version.split()[0],
    }
    prov["taskMap"] = task_map
    write(KIT / "provenance.json", json.dumps(prov, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
