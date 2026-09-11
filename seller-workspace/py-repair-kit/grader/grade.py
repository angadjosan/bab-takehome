"""Grading entrypoint: run a task's hidden tests against an agent's final workspace.

The grader never trusts the workspace wholesale. It rebuilds the task's
starting state in a fresh temporary directory, copies in only the files the
task allows the agent to edit (``editableFiles``), adds the hidden tests and a
generated ``pytest.ini``, and runs pytest in a subprocess with a timeout.

CLI::

    python -m grader.grade --task T1 --workspace DIR [--termination submitted]
                           [--task-root DIR ...] [--timeout SEC]

prints one JSON object::

    {"taskId", "score": 0|1, "success": bool, "termination", "passed", "failed",
     "diagnostics": {...private...}}

``success`` (and ``score`` 1) require every hidden test to pass AND the
episode to have ended by submission (``termination == "submitted"``).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional, Sequence

from .tasks import (
    GRADER_VERSION,
    MAX_WRITE_BYTES,
    PYTEST_INI,
    Task,
    TaskError,
    digest_files,
    is_editable,
    iter_files,
    load_task,
    materialize_base,
    run_command,
    tail,
)


def _parse_junit(path: Path) -> dict:
    counts = {"total": 0, "failures": 0, "errors": 0, "skipped": 0, "failedTests": []}
    if not path.is_file():
        return counts
    root = ET.parse(path).getroot()
    for case in root.iter("testcase"):
        counts["total"] += 1
        tags = {child.tag for child in case}
        name = f"{case.get('classname', '')}::{case.get('name', '')}"
        if "failure" in tags:
            counts["failures"] += 1
            counts["failedTests"].append(name)
        elif "error" in tags:
            counts["errors"] += 1
            counts["failedTests"].append(name)
        elif "skipped" in tags:
            counts["skipped"] += 1
    return counts


def grade_workspace(
    task: Task, workspace: Path, termination: str = "submitted", timeout: Optional[float] = None
) -> dict:
    workspace = Path(workspace)
    if not workspace.is_dir():
        raise TaskError("bad_workspace", f"workspace not found: {workspace}")
    gdir = Path(tempfile.mkdtemp(prefix="pyrepair-grade-"))
    jdir = Path(tempfile.mkdtemp(prefix="pyrepair-junit-"))
    edited: list[str] = []
    rejected: list[str] = []
    try:
        materialize_base(task, gdir)
        for rel in iter_files(workspace):
            if not is_editable(task, rel):
                continue
            data = (workspace / rel).read_bytes()
            if len(data) > MAX_WRITE_BYTES:
                rejected.append(rel)
                continue
            target = gdir / rel
            if not target.is_file() or target.read_bytes() != data:
                edited.append(rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        graded_digest = digest_files(gdir, [r for r in iter_files(gdir)])
        shutil.copytree(task.hidden_tests_dir, gdir / "hidden_tests")
        (gdir / "pytest.ini").write_text(PYTEST_INI, encoding="utf-8")
        junit = jdir / "junit.xml"
        argv = [
            sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
            "-o", "addopts=", "--color=no", f"--junitxml={junit}", "hidden_tests",
        ]
        run = run_command(argv, gdir, timeout if timeout is not None else task.grade_timeout_sec)
        counts = _parse_junit(junit)
    finally:
        shutil.rmtree(gdir, ignore_errors=True)
        shutil.rmtree(jdir, ignore_errors=True)

    failed = counts["failures"] + counts["errors"]
    passed = counts["total"] - failed - counts["skipped"]
    all_passed = (
        not run["timedOut"]
        and run["exitCode"] == 0
        and counts["total"] > 0
        and failed == 0
        and counts["skipped"] == 0
    )
    success = all_passed and termination == "submitted"
    return {
        "taskId": task.task_id,
        "score": 1 if success else 0,
        "success": success,
        "termination": termination,
        "passed": passed,
        "failed": failed,
        "diagnostics": {
            "graderVersion": GRADER_VERSION,
            "allHiddenTestsPassed": all_passed,
            "collected": counts["total"],
            "skipped": counts["skipped"],
            "errors": counts["errors"],
            "failedTests": counts["failedTests"],
            "pytestExitCode": run["exitCode"],
            "timedOut": run["timedOut"],
            "durationSec": run["durationSec"],
            "editedFiles": edited,
            "rejectedFiles": rejected,
            "gradedTreeDigest": graded_digest,
            "outputTail": tail(run["output"], 4000),
        },
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m grader.grade", description=__doc__.split("\n")[0])
    ap.add_argument("--task", required=True)
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--termination", default="submitted")
    ap.add_argument("--task-root", action="append", default=None)
    ap.add_argument("--timeout", type=float, default=None)
    args = ap.parse_args(argv)
    try:
        task = load_task(args.task, [Path(p) for p in args.task_root] if args.task_root else None)
        result = grade_workspace(task, Path(args.workspace), args.termination, args.timeout)
    except TaskError as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": exc.message}}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
