"""Drive the real environment CLI end to end for every task and check the task contract.

For each task in tasks/ and audit-tasks/:
  1. reset (serve mode) and one list_files through the one-shot CLI
  2. visible tests FAIL on the starting state
  3. hidden tests FAIL on the starting state (python -m grader.grade)
  4. the reference solution is written with write_file actions
  5. visible tests PASS, submit, grade -> score 1, 0 failed; a second grade is identical
Plus protocol checks: path escapes, non-editable writes, budget exhaustion.
Exit code 0 only if everything holds.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT))

from grader.tasks import iter_files, list_task_dirs, load_task  # noqa: E402

PY = sys.executable
FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILURES.append(msg)
        print(f"   FAIL: {msg}")


class Server:
    def __init__(self) -> None:
        self.p = subprocess.Popen(
            [PY, "-m", "grader.env", "serve"], cwd=KIT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
        )
        self.n = 0

    def call(self, **req) -> dict:
        self.n += 1
        req["id"] = self.n
        self.p.stdin.write(json.dumps(req) + "\n")
        self.p.stdin.flush()
        resp = json.loads(self.p.stdout.readline())
        assert resp.get("id") == self.n, resp
        return resp

    def stop(self) -> None:
        self.p.stdin.close()
        self.p.wait(timeout=10)


def cli(*args: str, stdin: str | None = None) -> dict:
    out = subprocess.run([PY, "-m", *args], cwd=KIT, input=stdin, capture_output=True, text=True, timeout=300)
    return json.loads(out.stdout.strip().splitlines()[-1])


def solution_dir(task) -> Path:
    local = task.dir / "solution"
    return local if local.is_dir() else KIT / "solutions" / task.task_id


def verify_task(srv: Server, tdir: Path, tmp: Path) -> dict:
    task = load_task(tdir.name)
    tid = task.task_id
    wd = tmp / f"ep-{tid}"
    print(f"-- {tid} ({task.spec['set']}, {task.spec['difficulty']}): {task.spec['title']}")

    r = srv.call(cmd="reset", taskId=tid, seed=0, workdir=str(wd))
    check(r["ok"], f"{tid}: reset failed {r}")
    files = r["observation"]["files"]
    check(not any(f.startswith(("tests/", "hidden_tests/")) for f in files), f"{tid}: hidden tests leaked into workspace")
    hidden_names = {p.name for p in task.hidden_tests_dir.iterdir()} - {"__init__.py"}
    check(not any(Path(f).name in hidden_names and not f.startswith("visible_tests/") for f in files),
          f"{tid}: hidden test file name present in workspace")

    one = cli("grader.env", "step", "--workdir", str(wd), "--action", json.dumps({"type": "list_files"}))
    check(one["ok"] and one["observation"]["ok"] and one["actionsUsed"] == 1, f"{tid}: one-shot list_files failed {one}")

    v = srv.call(cmd="step", action={"type": "run_visible_tests"})
    check(v["ok"] and v["observation"]["exitCode"] != 0, f"{tid}: visible tests should FAIL on starting state")

    buggy = cli("grader.grade", "--task", tid, "--workspace", str(wd / "workspace"))
    check(buggy["success"] is False and buggy["failed"] > 0, f"{tid}: hidden tests should FAIL on starting state: {buggy}")

    sol = solution_dir(task)
    sol_files = iter_files(sol)
    check(bool(sol_files), f"{tid}: no reference solution files in {sol}")
    for rel in sol_files:
        before = (wd / "workspace" / rel).read_bytes()
        check(before != (sol / rel).read_bytes(), f"{tid}: solution file {rel} identical to starting state")
        w = srv.call(cmd="step", action={"type": "write_file", "path": rel, "content": (sol / rel).read_text()})
        check(w["ok"] and w["observation"]["ok"], f"{tid}: write_file {rel} failed {w}")

    v2 = srv.call(cmd="step", action={"type": "run_visible_tests"})
    check(v2["observation"]["exitCode"] == 0, f"{tid}: visible tests should PASS with solution:\n{v2['observation'].get('output')}")
    s = srv.call(cmd="step", action={"type": "submit"})
    check(s["done"] and s["termination"] == "submitted", f"{tid}: submit failed {s}")

    g = srv.call(cmd="grade")["result"]
    check(g["success"] and g["score"] == 1 and g["failed"] == 0 and g["passed"] > 0,
          f"{tid}: hidden tests should PASS with solution: {g['diagnostics'].get('failedTests')}\n{g['diagnostics'].get('outputTail')}")
    g2 = srv.call(cmd="grade")["result"]
    check(all(g[k] == g2[k] for k in ("score", "success", "passed", "failed")), f"{tid}: grading not repeatable")
    c = srv.call(cmd="close")
    check(c["ok"] and c["closed"] and not wd.exists(), f"{tid}: close failed")

    row = {
        "task": tid,
        "set": task.spec["set"],
        "difficulty": task.spec["difficulty"],
        "hiddenTests": g["passed"] + g["failed"],
        "buggyFailed": buggy["failed"],
        "buggyPassed": buggy["passed"],
        "fixedPassed": g["passed"],
        "actionsUsed": g["diagnostics"]["actionsUsed"],
    }
    print(f"   ok: hidden {row['hiddenTests']} | starting state {row['buggyFailed']} failed / {row['buggyPassed']} passed"
          f" | with solution {row['fixedPassed']} passed | actions {row['actionsUsed']}")
    return row


def protocol_checks(srv: Server, tmp: Path) -> None:
    first = list_task_dirs()[0].name
    task = load_task(first)
    module = iter_files(task.overlay_dir)[0]
    print(f"-- protocol checks ({first})")
    wd = str(tmp / "ep-protocol")
    srv.call(cmd="reset", taskId=first, seed=0, workdir=wd)
    bad = [
        ({"type": "read_file", "path": "../episode.json"}, "bad_path"),
        ({"type": "read_file", "path": "/etc/passwd"}, "bad_path"),
        ({"type": "write_file", "path": "visible_tests/test_visible.py", "content": "def test_x():\n    pass\n"}, "not_editable"),
        ({"type": "write_file", "path": "buildkit/conftest.py", "content": ""}, "not_editable"),
        ({"type": "write_file", "path": "pytest.ini", "content": ""}, "not_editable"),
        ({"type": "rm_rf"}, "unknown_action"),
    ]
    for action, code in bad:
        r = srv.call(cmd="step", action=action)
        check(r["ok"] and not r["observation"]["ok"] and r["observation"].get("errorCode") == code,
              f"protocol: {action} should fail with {code}: {r['observation']}")
    while True:
        r = srv.call(cmd="step", action={"type": "list_files"})
        if r["actionsRemaining"] == 0:
            break
    check(r["actionsUsed"] == task.action_budget and not r["done"], f"protocol: budget accounting wrong {r}")
    r = srv.call(cmd="step", action={"type": "read_file", "path": module})
    check(r["done"] and r["termination"] == "budget_exhausted", f"protocol: budget exhaustion not enforced {r}")
    r = srv.call(cmd="step", action={"type": "submit"})
    check(not r["ok"] and r["error"]["code"] == "episode_done", f"protocol: step after end should error {r}")
    g = srv.call(cmd="grade")["result"]
    check(g["score"] == 0 and g["termination"] == "budget_exhausted", f"protocol: exhausted episode must score 0 {g}")
    srv.call(cmd="close")
    print("   ok" if not FAILURES else "   (see failures above)")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="buildkit-verify-"))
    srv = Server()
    rows = []
    try:
        for tdir in list_task_dirs():
            rows.append(verify_task(srv, tdir, tmp))
        protocol_checks(srv, tmp)
    finally:
        srv.stop()
    print()
    print(f"{'task':<5} {'set':<10} {'difficulty':<10} {'hidden':>6} {'fail@start':>10} {'pass@fix':>8}")
    for r in rows:
        print(f"{r['task']:<5} {r['set']:<10} {r['difficulty']:<10} {r['hiddenTests']:>6} {r['buggyFailed']:>10} {r['fixedPassed']:>8}")
    purchased = [r for r in rows if r["set"] == "purchased"]
    audit = [r for r in rows if r["set"] == "audit"]
    print(f"\npurchased tasks: {len(purchased)}  audit tasks: {len(audit)}")
    if FAILURES:
        print(f"\nVERIFY FAILED: {len(FAILURES)} problem(s)")
        return 1
    print("VERIFY PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
