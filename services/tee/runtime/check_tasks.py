"""TEE-side task checker. Runs INSIDE the sandbox (offline, unprivileged) with the bundle's own
grader, so seller code never runs outside isolation.

For each task: materialize the starting workspace with the seller's grader, grade it with the
hidden tests (collect count + expected failures), then (if a reference solution exists) apply it
and grade again. Used by the upload preflight and the mechanical verifier.

    python check_tasks.py --kit <payload root> [--task-root DIR ...] --tasks T1,T2 [--solutions DIR]

Prints one JSON object on stdout. Stdlib only (pytest is invoked by the seller grader).
"""

import argparse
import json
import shutil
import sys
import tempfile
import traceback
from pathlib import Path


def summarize(res):
    d = res.get("diagnostics", {})
    return {
        "passed": res.get("passed"),
        "failed": res.get("failed"),
        "collected": d.get("collected"),
        "skipped": d.get("skipped"),
        "allPassed": bool(d.get("allHiddenTestsPassed")),
        "timedOut": bool(d.get("timedOut")),
        "pytestExitCode": d.get("pytestExitCode"),
        "failedTests": (d.get("failedTests") or [])[:20],
        "durationSec": d.get("durationSec"),
        "outputTail": (d.get("outputTail") or "")[-1500:],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kit", required=True)
    ap.add_argument("--task-root", action="append", default=None)
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--solutions", default=None)
    args = ap.parse_args()

    kit = Path(args.kit).resolve()
    sys.path.insert(0, str(kit))
    out = {"python": sys.version.split()[0], "imports": {"ok": False}, "tasks": []}
    try:
        import grader.env  # noqa: F401
        import grader.grade as gg
        import grader.tasks as gt
        import pytest  # noqa: F401

        out["imports"] = {"ok": True, "environmentVersion": getattr(gt, "ENVIRONMENT_VERSION", None), "pytest": pytest.__version__}
    except Exception as exc:  # build failure: the grader cannot even be imported
        out["imports"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[-1500:]}
        print(json.dumps(out, sort_keys=True))
        return 0

    roots = [Path(p) for p in args.task_root] if args.task_root else None
    for tid in [t for t in args.tasks.split(",") if t]:
        row = {"taskId": tid, "ok": False}
        tmp = Path(tempfile.mkdtemp(prefix="chk-"))
        try:
            task = gt.load_task(tid, roots)
            ws = tmp / "ws"
            gt.materialize_workspace(task, ws)
            row["start"] = summarize(gg.grade_workspace(task, ws, "submitted"))
            row["hiddenTestCount"] = row["start"]["collected"]
            row["hiddenTestFiles"] = sorted(p.name for p in task.hidden_tests_dir.iterdir() if p.is_file())
            local = task.dir / "solution"
            sol = local if local.is_dir() else (Path(args.solutions) / tid if args.solutions else None)
            if sol is not None and sol.is_dir():
                files = gt.iter_files(sol)
                for rel in files:
                    target = ws / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((sol / rel).read_bytes())
                row["solution"] = {"present": True, "files": files, **summarize(gg.grade_workspace(task, ws, "submitted"))}
            else:
                row["solution"] = {"present": False}
            row["ok"] = True
        except Exception as exc:
            row["error"] = f"{type(exc).__name__}: {exc}"
            row["trace"] = traceback.format_exc()[-1500:]
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        out["tasks"].append(row)
    print(json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
