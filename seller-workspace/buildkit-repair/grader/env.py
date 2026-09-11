"""Coding-repair environment: reset / step / grade / close, plus a JSON CLI.

Episode state lives on disk in ``<workdir>/episode.json``; the agent's files
live in ``<workdir>/workspace/``. Every command is therefore usable either as
a one-shot subprocess or through the long-lived JSON-lines ``serve`` mode, and
the two can be mixed.

One-shot commands (each prints exactly one JSON line on stdout)::

    python -m grader.env reset T1 --seed 0 --workdir DIR [--task-root DIR ...]
    python -m grader.env step  --workdir DIR --action '{"type": "list_files"}'
    python -m grader.env step  --workdir DIR            # action JSON read from stdin
    python -m grader.env grade --workdir DIR
    python -m grader.env close --workdir DIR

JSON-lines server (one request per stdin line, one response per stdout line)::

    python -m grader.env serve [--task-root DIR ...]
    -> {"id": 1, "cmd": "reset", "taskId": "T1", "seed": 0, "workdir": "/tmp/ep1"}
    <- {"id": 1, "ok": true, ...}

Actions (``step``):

    {"type": "list_files", "path": "."}                    path optional
    {"type": "read_file", "path": "buildkit/<module>.py"}
    {"type": "write_file", "path": "buildkit/<module>.py", "content": "..."}
    {"type": "run_visible_tests"}
    {"type": "submit"}

The action budget counts every non-submit action (including invalid ones).
Submit is always accepted while the episode is open. Once the budget is used
up, only submit is accepted; any other action ends the episode with
termination "budget_exhausted". An action arriving after the wall-clock time
budget ends the episode with termination "timeout".
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Optional, Sequence

from .grade import grade_workspace
from .tasks import (
    ENVIRONMENT_VERSION,
    MAX_WRITE_BYTES,
    TaskError,
    digest_files,
    is_editable,
    iter_files,
    load_task,
    materialize_workspace,
    resolve_in,
    run_command,
    tail,
)

STATE_FILE = "episode.json"
WORKSPACE_DIR = "workspace"
READ_LIMIT = 64 * 1024
OUTPUT_LIMIT = 8000
VISIBLE_TIMEOUT_SEC = 60.0
TOOL_ACTIONS = ("list_files", "read_file", "write_file", "run_visible_tests")

ACTION_SCHEMA = {
    "list_files": {"path": "optional workspace-relative directory, default '.'"},
    "read_file": {"path": "workspace-relative file path"},
    "write_file": {"path": "workspace-relative path matching an editable pattern", "content": "full new file text"},
    "run_visible_tests": {},
    "submit": {},
}


class EnvError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _roots(task_roots: Optional[Sequence[str]]) -> Optional[list[Path]]:
    return [Path(p) for p in task_roots] if task_roots else None


def _load_state(workdir: str) -> tuple[Path, dict]:
    wd = Path(workdir).resolve()
    path = wd / STATE_FILE
    if not path.is_file():
        raise EnvError("no_episode", f"no episode in {wd}; call reset first")
    return wd, json.loads(path.read_text(encoding="utf-8"))


def _save_state(wd: Path, state: dict) -> None:
    tmp = wd / (STATE_FILE + ".tmp")
    tmp.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    tmp.replace(wd / STATE_FILE)


def _status(state: dict) -> dict:
    return {
        "done": state["done"],
        "termination": state["termination"],
        "actionsUsed": state["actionsUsed"],
        "actionsRemaining": max(0, state["actionBudget"] - state["actionsUsed"]),
        "elapsedSec": round(time.time() - state["startedAt"], 3),
    }


def reset(
    task_id: str,
    seed: int,
    workdir: str,
    task_roots: Optional[Sequence[str]] = None,
    action_budget: Optional[int] = None,
    time_budget_sec: Optional[float] = None,
) -> dict:
    task = load_task(task_id, _roots(task_roots))
    wd = Path(workdir).resolve()
    if wd.exists():
        if (wd / STATE_FILE).is_file():
            shutil.rmtree(wd)
        elif any(wd.iterdir()):
            raise EnvError("workdir_not_empty", f"refusing to reset into non-empty directory {wd}")
    wd.mkdir(parents=True, exist_ok=True)
    ws = wd / WORKSPACE_DIR
    materialize_workspace(task, ws)
    files = iter_files(ws)
    state = {
        "environmentVersion": ENVIRONMENT_VERSION,
        "taskId": task.task_id,
        "taskDir": str(task.dir),
        "taskRoots": [str(p) for p in task_roots] if task_roots else None,
        "seed": int(seed),
        "actionBudget": int(action_budget if action_budget is not None else task.action_budget),
        "timeBudgetSec": float(time_budget_sec if time_budget_sec is not None else task.time_budget_sec),
        "startedAt": time.time(),
        "actionsUsed": 0,
        "done": False,
        "termination": None,
        "startDigest": digest_files(ws, files),
        "log": [],
    }
    _save_state(wd, state)
    observation = {
        "taskId": task.task_id,
        "title": task.spec["title"],
        "statement": task.spec["statement"],
        "files": files,
        "editable": task.editable,
        "visibleTestCmd": task.visible_cmd,
        "actionBudget": state["actionBudget"],
        "timeBudgetSec": state["timeBudgetSec"],
        "actions": ACTION_SCHEMA,
    }
    return {"taskId": task.task_id, "seed": state["seed"], "workdir": str(wd), "observation": observation, **_status(state)}


def _do_action(task, ws: Path, action: dict, remaining_sec: float) -> dict:
    kind = action.get("type")
    if kind == "list_files":
        base = resolve_in(ws, action.get("path", "."))
        if not base.is_dir():
            raise TaskError("not_a_directory", f"not a directory: {action.get('path')}")
        prefix = base.relative_to(ws.resolve()).as_posix()
        files = iter_files(base)
        if prefix != ".":
            files = [f"{prefix}/{f}" for f in files]
        return {"files": files}
    if kind == "read_file":
        target = resolve_in(ws, action.get("path"))
        if not target.is_file() or target.is_symlink():
            raise TaskError("not_found", f"no such file: {action.get('path')}")
        data = target.read_bytes()
        return {
            "path": target.relative_to(ws.resolve()).as_posix(),
            "content": data[:READ_LIMIT].decode("utf-8", errors="replace"),
            "truncated": len(data) > READ_LIMIT,
            "bytes": len(data),
        }
    if kind == "write_file":
        rel = action.get("path")
        content = action.get("content")
        target = resolve_in(ws, rel)
        relpath = target.relative_to(ws.resolve()).as_posix()
        if not is_editable(task, relpath):
            raise TaskError("not_editable", f"{relpath} is not editable; editable patterns: {task.editable}")
        if not isinstance(content, str):
            raise TaskError("bad_content", "content must be a string")
        data = content.encode("utf-8")
        if len(data) > MAX_WRITE_BYTES:
            raise TaskError("too_large", f"content exceeds {MAX_WRITE_BYTES} bytes")
        if target.is_symlink():
            raise TaskError("bad_path", "refusing to write through a symlink")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"path": relpath, "bytes": len(data)}
    if kind == "run_visible_tests":
        run = run_command(task.visible_argv(), ws, min(VISIBLE_TIMEOUT_SEC, max(1.0, remaining_sec)))
        return {
            "command": task.visible_cmd,
            "exitCode": run["exitCode"],
            "passed": run["exitCode"] == 0 and not run["timedOut"],
            "timedOut": run["timedOut"],
            "output": tail(run["output"], OUTPUT_LIMIT),
        }
    raise TaskError("unknown_action", f"unknown action type {kind!r}; expected one of {list(ACTION_SCHEMA)}")


def step(workdir: str, action: dict) -> dict:
    wd, state = _load_state(workdir)
    if state["done"]:
        raise EnvError("episode_done", f"episode already ended ({state['termination']})")
    if not isinstance(action, dict):
        action = {"type": None}
    kind = action.get("type")
    elapsed = time.time() - state["startedAt"]
    entry = {"i": len(state["log"]), "type": kind, "path": action.get("path"), "t": round(elapsed, 3)}

    if elapsed > state["timeBudgetSec"]:
        state.update(done=True, termination="timeout")
        obs = {"type": kind, "ok": False, "error": "time budget exhausted; the episode has ended"}
    elif kind == "submit":
        state.update(done=True, termination="submitted")
        obs = {"type": "submit", "ok": True, "message": "Submitted. The episode has ended."}
    elif state["actionsUsed"] >= state["actionBudget"]:
        state.update(done=True, termination="budget_exhausted")
        obs = {"type": kind, "ok": False, "error": "action budget exhausted; the episode has ended"}
    else:
        state["actionsUsed"] += 1
        task = load_task(state["taskId"], _roots(state["taskRoots"]))
        try:
            result = _do_action(task, wd / WORKSPACE_DIR, action, state["timeBudgetSec"] - elapsed)
            obs = {"type": kind, "ok": True, **result}
        except TaskError as exc:
            obs = {"type": kind, "ok": False, "error": exc.message, "errorCode": exc.code}
        if state["actionsUsed"] >= state["actionBudget"]:
            obs["notice"] = "action budget used up: the next action must be submit"
    entry["ok"] = obs["ok"]
    state["log"].append(entry)
    _save_state(wd, state)
    return {"observation": obs, **_status(state)}


def grade(workdir: str) -> dict:
    wd, state = _load_state(workdir)
    task = load_task(state["taskId"], _roots(state["taskRoots"]))
    termination = state["termination"] if state["done"] else "incomplete"
    result = grade_workspace(task, wd / WORKSPACE_DIR, termination)
    result["diagnostics"]["actionsUsed"] = state["actionsUsed"]
    result["diagnostics"]["seed"] = state["seed"]
    state["grade"] = {k: result[k] for k in ("score", "success", "termination", "passed", "failed")}
    _save_state(wd, state)
    return {"result": result}


def close(workdir: str) -> dict:
    wd = Path(workdir).resolve()
    if (wd / STATE_FILE).is_file():
        shutil.rmtree(wd)
        return {"closed": True}
    return {"closed": False}


def _dispatch(req: dict, default_roots: Optional[Sequence[str]], last_workdir: Optional[str]) -> dict:
    cmd = req.get("cmd")
    workdir = req.get("workdir") or last_workdir
    if cmd == "ping":
        return {"pong": True, "environmentVersion": ENVIRONMENT_VERSION}
    if cmd == "reset":
        if not workdir:
            raise EnvError("bad_request", "reset needs workdir")
        return reset(
            req.get("taskId"),
            int(req.get("seed", 0)),
            workdir,
            req.get("taskRoots") or default_roots,
            req.get("actionBudget"),
            req.get("timeBudgetSec"),
        )
    if not workdir:
        raise EnvError("bad_request", f"{cmd} needs workdir")
    if cmd == "step":
        return step(workdir, req.get("action"))
    if cmd == "grade":
        return grade(workdir)
    if cmd == "close":
        return close(workdir)
    raise EnvError("unknown_cmd", f"unknown cmd {cmd!r}")


def _respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
    sys.stdout.flush()


def serve(default_roots: Optional[Sequence[str]]) -> int:
    last_workdir: Optional[str] = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise EnvError("bad_request", "request must be a JSON object")
            rid = req.get("id")
            result = _dispatch(req, default_roots, last_workdir)
            if req.get("cmd") == "reset":
                last_workdir = result["workdir"]
            _respond({"id": rid, "ok": True, **result})
        except (EnvError, TaskError) as exc:
            _respond({"id": rid, "ok": False, "error": {"code": exc.code, "message": exc.message}})
        except json.JSONDecodeError as exc:
            _respond({"id": rid, "ok": False, "error": {"code": "bad_json", "message": str(exc)}})
        except Exception as exc:  # keep the server alive; report the failure
            _respond({"id": rid, "ok": False, "error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"}})
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m grader.env")
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("reset")
    p.add_argument("task_id")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--workdir", required=True)
    p.add_argument("--task-root", action="append", default=None)
    p.add_argument("--action-budget", type=int, default=None)
    p.add_argument("--time-budget", type=float, default=None)
    p = sub.add_parser("step")
    p.add_argument("--workdir", required=True)
    p.add_argument("--action", default=None, help="action JSON; read from stdin if omitted or '-'")
    for name in ("grade", "close"):
        sub.add_parser(name).add_argument("--workdir", required=True)
    p = sub.add_parser("serve")
    p.add_argument("--task-root", action="append", default=None)
    args = ap.parse_args(argv)

    if args.command == "serve":
        return serve(args.task_root)
    try:
        if args.command == "reset":
            result = reset(args.task_id, args.seed, args.workdir, args.task_root, args.action_budget, args.time_budget)
        elif args.command == "step":
            raw = sys.stdin.read() if args.action in (None, "-") else args.action
            try:
                action = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise EnvError("bad_json", f"action is not valid JSON: {exc}") from exc
            result = step(args.workdir, action)
        elif args.command == "grade":
            result = grade(args.workdir)
        else:
            result = close(args.workdir)
    except (EnvError, TaskError) as exc:
        _respond({"ok": False, "error": {"code": exc.code, "message": exc.message}})
        return 2
    _respond({"ok": True, **result})
    return 0


if __name__ == "__main__":
    sys.exit(main())
