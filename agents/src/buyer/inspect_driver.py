"""Buyer inspection driver. Runs INSIDE the offline sandbox (docker --network none, read-only,
bundle mounted at /env). Measures the delivered environment with its own grader and prints one
JSON object on stdout. It only reads the bundle and writes to /tmp.

Measurements:
  python        interpreter version + stdlib module names
  network       outbound socket probe (expected: blocked)
  tasks[id]     pytest --collect-only counts for hidden and visible tests; grade of the untouched
                starting state; grade of the reference solution (twice, for determinism)
  episode       env probe on the first task: reset, list_files, then exhaust the action budget
"""
import json
import os
import platform
import re
import socket
import subprocess
import sys
import tempfile
import time

ENV = os.environ.get("BUNDLE_ROOT", "/env")
PY = sys.executable


def run(argv, cwd=ENV, timeout=300, extra_env=None):
    env = dict(os.environ)
    env.update(extra_env or {})
    t0 = time.time()
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
        return {"code": p.returncode, "out": p.stdout, "err": p.stderr, "sec": round(time.time() - t0, 2), "timedOut": False}
    except subprocess.TimeoutExpired:
        return {"code": None, "out": "", "err": "timeout", "sec": timeout, "timedOut": True}


def last_json(text):
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def collect(test_dir):
    r = run([PY, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", test_dir], extra_env={"PYTHONPATH": os.path.join(ENV, "src")})
    ids = [l.strip() for l in r["out"].splitlines() if "::" in l]
    m = re.search(r"(\d+) tests? collected", r["out"])
    return {
        "exitCode": r["code"],
        "count": len(ids),
        "summaryCount": int(m.group(1)) if m else None,
        "nodeIds": ids,
        "tail": (r["out"][-1200:] + r["err"][-400:]),
    }


def grade(task_id, workspace):
    r = run([PY, "-m", "grader.grade", "--task", task_id, "--workspace", workspace, "--task-root", os.path.join(ENV, "tasks")], timeout=400)
    j = last_json(r["out"])
    if j is None:
        return {"error": (r["err"] or r["out"])[-1500:], "exitCode": r["code"], "timedOut": r["timedOut"]}
    diag = j.get("diagnostics") or {}
    return {
        "success": j.get("success"),
        "score": j.get("score"),
        "passed": j.get("passed"),
        "failed": j.get("failed"),
        "termination": j.get("termination"),
        "collected": diag.get("collected"),
        "failedTests": diag.get("failedTests"),
        "timedOut": diag.get("timedOut"),
        "durationSec": diag.get("durationSec"),
    }


def env_cmd(args):
    r = run([PY, "-m", "grader.env"] + args, timeout=120)
    return last_json(r["out"]) or {"error": (r["err"] or r["out"])[-800:]}


def main():
    res = {"python": {"version": platform.python_version(), "implementation": sys.implementation.name, "stdlib": sorted(sys.stdlib_module_names)}}
    try:
        s = socket.create_connection(("1.1.1.1", 53), timeout=3)
        s.close()
        res["network"] = "open"
    except OSError as e:
        res["network"] = "blocked (%s)" % e.__class__.__name__

    tasks_root = os.path.join(ENV, "tasks")
    task_ids = sorted(d for d in os.listdir(tasks_root) if os.path.isfile(os.path.join(tasks_root, d, "task.json")))
    res["taskIds"] = task_ids
    res["tasks"] = {}
    for tid in task_ids:
        spec = json.load(open(os.path.join(tasks_root, tid, "task.json"), encoding="utf-8"))
        hidden = os.path.join("tasks", tid, spec.get("hiddenTestsDir", "tests/").rstrip("/"))
        visible = os.path.join("tasks", tid, spec.get("visibleTestsDir", "visible_tests/").rstrip("/"))
        t = {"hiddenCollect": collect(hidden)}
        if os.path.isdir(os.path.join(ENV, visible)):
            t["visibleCollect"] = collect(visible)
        empty = tempfile.mkdtemp(prefix="start-")
        t["startState"] = grade(tid, empty)
        sol = os.path.join(ENV, "solutions", tid)
        if os.path.isdir(sol):
            t["solution"] = [grade(tid, sol), grade(tid, sol)]
        res["tasks"][tid] = t

    # Episode probe: budget + workspace isolation (first task).
    if task_ids:
        tid = task_ids[0]
        spec = json.load(open(os.path.join(tasks_root, tid, "task.json"), encoding="utf-8"))
        budget = int(spec.get("actionBudget", 12))
        wd = tempfile.mkdtemp(prefix="ep-")
        reset = env_cmd(["reset", tid, "--seed", "0", "--workdir", wd])
        steps = []
        for _ in range(budget + 1):
            o = env_cmd(["step", "--workdir", wd, "--action", json.dumps({"type": "list_files", "path": "."})])
            steps.append(o)
            if o.get("done") or (o.get("envelope") or {}).get("done"):
                break
        files = []
        first = steps[0] if steps else {}
        for k in ("files",):
            files = first.get(k) or (first.get("list_files") or {}).get("files") or []
        workspace_files = []
        for root, _dirs, names in os.walk(os.path.join(wd, "workspace")):
            for n in names:
                workspace_files.append(os.path.relpath(os.path.join(root, n), os.path.join(wd, "workspace")))
        # second episode: use the full budget, then submit (submit must still be accepted)
        wd2 = tempfile.mkdtemp(prefix="ep2-")
        env_cmd(["reset", tid, "--seed", "0", "--workdir", wd2])
        last = None
        for _ in range(budget):
            last = env_cmd(["step", "--workdir", wd2, "--action", json.dumps({"type": "list_files"})])
        submit = env_cmd(["step", "--workdir", wd2, "--action", json.dumps({"type": "submit"})])
        res["episode"] = {
            "taskId": tid,
            "actionBudget": budget,
            "reset": {k: reset.get(k) for k in ("ok", "taskId", "actionBudget", "timeBudgetSec", "files", "editable", "error")},
            "steps": [
                {
                    "ok": s.get("ok"),
                    "error": s.get("error"),
                    "errorCode": s.get("errorCode"),
                    "done": s.get("done", (s.get("envelope") or {}).get("done")),
                    "termination": s.get("termination", (s.get("envelope") or {}).get("termination")),
                    "actionsUsed": s.get("actionsUsed", (s.get("envelope") or {}).get("actionsUsed")),
                    "actionsRemaining": s.get("actionsRemaining", (s.get("envelope") or {}).get("actionsRemaining")),
                }
                for s in steps
            ],
            "listedFiles": files,
            "workspaceFiles": sorted(workspace_files),
            "afterFullBudget": {"actionsRemaining": (last or {}).get("actionsRemaining", ((last or {}).get("envelope") or {}).get("actionsRemaining"))},
            "submitAfterBudget": {
                "ok": submit.get("ok"),
                "done": submit.get("done", (submit.get("envelope") or {}).get("done")),
                "termination": submit.get("termination", (submit.get("envelope") or {}).get("termination")),
                "error": submit.get("error"),
            },
        }
    print(json.dumps(res))


if __name__ == "__main__":
    main()
