"""Hidden-test grading in its own sandboxed process (the manifest's `entrypoints.gradeArtifact`).

The agent phase (env server) never has the hidden tests in reach: agent-written code runs there
during visible tests and could otherwise read and print them. Grading runs a fresh process, with
a different uid under `unshare`, over a kit that holds the hidden tests plus the final workspace
mounted read-only. The grader itself rebuilds the starting state and copies in only editable files,
so re-grading a stored set of edited files gives the same graded tree (`gradedTreeDigest`).
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from .bundle import Bundle, build_kit
from .envserver import run_once
from .sandbox import Sandbox

GRADE_TIMEOUT_SEC = 240


class GradeError(RuntimeError):
    pass


def _set_flag(args: list[str], flag: str, value: str) -> list[str]:
    out = list(args)
    if flag in out and out.index(flag) + 1 < len(out):
        out[out.index(flag) + 1] = value
    else:
        out += [flag, value]
    return out


class Grader:
    def __init__(self, bundle: Bundle, sandbox: Sandbox, venv: Path, work_root: Path) -> None:
        self.bundle, self.sandbox, self.venv, self.work_root = bundle, sandbox, Path(venv), Path(work_root)
        sandbox.prepare_root(self.work_root)
        sandbox.check_layout(traversable=[self.work_root, self.venv], private=[bundle.root, bundle.audit_dir])

    async def grade(self, task_id: str, split: str, workspace: Path, termination: str, scratch: Path | None = None) -> dict:
        """Returns the grader's result object {taskId, score, success, termination, passed, failed, diagnostics}."""
        own_scratch = scratch is None
        if own_scratch:
            scratch = Path(tempfile.mkdtemp(prefix=f"grade-{task_id}-", dir=self.sandbox.prepare_root(self.work_root)))
            if self.sandbox.kind == "unshare":
                scratch.chmod(0o711)
        kit = build_kit(scratch, self.bundle, split, task_id, with_hidden=True)
        if self.sandbox.kind == "unshare":
            # the agent phase's dirs belong to its uid (0700); give the grading uid its own copy
            copy = scratch / "graded-workspace"
            shutil.copytree(workspace, copy, symlinks=True)
            workspace = copy
        gtmp = scratch / "gtmp"
        gtmp.mkdir(exist_ok=True)
        uid = self.sandbox.next_uid()
        self.sandbox.grant(kit, uid, False)
        self.sandbox.grant(workspace, uid, False)
        self.sandbox.grant(gtmp, uid, True)
        args = self.bundle.python_args("gradeArtifact", {"taskId": task_id, "dir": str(workspace)})
        args = _set_flag(args, "--termination", termination)
        extra = {"TMPDIR": str(gtmp), "HOME": str(gtmp)} if self.sandbox.kind == "unshare" else None
        cmd = self.sandbox.command(self.venv, args, kit, [kit, workspace], [gtmp], uid, GRADE_TIMEOUT_SEC, extra)
        code, out, err, timed_out = await run_once(cmd, self.sandbox, GRADE_TIMEOUT_SEC)
        lines = [ln for ln in out.strip().splitlines() if ln.strip()]
        try:
            result = json.loads(lines[-1]) if lines else None
        except json.JSONDecodeError:
            result = None
        if not isinstance(result, dict):
            raise GradeError(f"grader produced no result (exit {code}{', timed out' if timed_out else ''}): {err[-400:]}")
        if result.get("ok") is False:
            raise GradeError(f"grader error: {(result.get('error') or {}).get('message', 'unknown')}")
        return result
