"""The verifiers environment: an EnvMarket coding bundle as a `vf.MultiTurnEnv` + hidden-test `vf.Rubric`.

Per rollout (= one pass@1 episode):
  setup_state   build an agent kit (src/, grader/, this task minus hidden tests/solutions), start
                the bundle's `entrypoints.serve` JSON-lines server in the sandbox, `reset` with the
                fixed seed into a fresh workdir, render the task message from the reset observation.
  model turns   verifiers calls the model with the manifest-generated tools; `env_response` turns
                each tool call into one `step` action and returns the observation as the tool
                message. No tool call -> a nudge (at most `max_idle_turns` in a row).
  stops         the env reports done (submit / budget_exhausted / timeout), max model calls
                (action_budget + extra_model_calls), wall-clock budget, idle limit, or an error.
  rubric        reward = the grader's `score` from `entrypoints.gradeArtifact` run over the final
                workspace in a separate sandboxed process with the hidden tests (1 only if every
                hidden test passes AND the episode ended by submit). Budget exhaustion, timeout,
                no submit and infra failures all score 0. The full per-episode record is stored in
                `state["em_record"]` (request it with `state_columns=["em_record"]`).
"""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import verifiers as vf
from datasets import Dataset
from verifiers.errors import InvalidModelResponseError, OverlongPromptError
from verifiers.types import SystemMessage, Tool, ToolMessage, UserMessage

from .bundle import Bundle, build_kit
from .digest import HARNESS_ID, canonical_json, harness_digest, prompt_digest, sha256_hex
from .envserver import EnvServer
from .grading import Grader
from .prompt import NUDGE, SYSTEM_PROMPT, render_task_message
from .sandbox import DEFAULT_PY_IMAGE, Sandbox

log = logging.getLogger("envmarket_coding")

MAX_IDLE_TURNS = 3
EXTRA_MODEL_CALLS = 6  # model calls allowed beyond the action budget (submit, recoveries)
TOOL_RESULT_MAX_CHARS = 12_000
STEP_TIMEOUT_SEC = 180
RESET_TIMEOUT_SEC = 180
TIMEOUT_GRACE_SEC = 60


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def default_work_root() -> Path:
    return Path(tempfile.gettempdir()).resolve() / "envmarket-harness"


@dataclass
class Episode:
    task_id: str
    split: str
    started_at: str
    t0: float = field(default_factory=time.monotonic)
    scratch: Path | None = None
    workdir: Path | None = None
    server: EnvServer | None = None
    reset_ok: bool = False
    deadline: float | None = None
    done: bool = False
    termination: str | None = None
    actions_used: int = 0
    actions: list[dict] = field(default_factory=list)
    idle: int = 0
    seed_sent: bool = True


def protocol_spec(action_budget: int, time_budget: float) -> dict:
    """The fixed harness rules (hash them into the report's protocol description)."""
    return {
        "harness": HARNESS_ID,
        "loop": "verifiers MultiTurnEnv; OpenAI-compatible chat completions with manifest-generated tools, toolChoice auto",
        "actionBudget": action_budget,
        "timeBudgetSec": time_budget,
        "maxModelCalls": action_budget + EXTRA_MODEL_CALLS,
        "maxIdleTurns": MAX_IDLE_TURNS,
        "toolResultMaxChars": TOOL_RESULT_MAX_CHARS,
        "episodesPerTask": 1,
        "retries": "none at episode level; transport-level HTTP retries only (429/5xx/connection)",
        "successRule": "grader score 1: every hidden test passes AND the episode ended by submit",
        "failures": "budget exhaustion, timeout, no submit and infrastructure failures score 0; infra failures are flagged status=infra_failure",
        "grading": "separate sandboxed process (entrypoints.gradeArtifact) with the hidden tests; the agent phase never contains hidden tests or solutions",
    }


class HiddenTestsRubric(vf.Rubric):
    """reward = hidden-test grade of the final workspace (0/1)."""

    def __init__(self, env: "EnvMarketCodingEnv") -> None:
        super().__init__()
        self.env = env
        self.add_reward_func(self.hidden_tests, weight=1.0)
        self.add_metric(self.actions_used)

    async def hidden_tests(self, state: vf.State, **_: Any) -> float:
        return await self.env.score_episode(state)

    async def actions_used(self, state: vf.State, **_: Any) -> float:
        ep = state.get("em")
        return float(ep.actions_used) if ep else 0.0

    @vf.cleanup
    async def remove_scratch(self, state: vf.State) -> None:
        ep = state.get("em")
        if ep and ep.scratch and not self.env.keep_workdirs:
            shutil.rmtree(ep.scratch, ignore_errors=True)


class EnvMarketCodingEnv(vf.MultiTurnEnv):
    def __init__(
        self,
        bundle: Bundle,
        split: str,
        task_ids: list[str],
        action_budget: int,
        time_budget: float,
        seed: int,
        sandbox: Sandbox,
        venv: Path,
        work_root: Path,
        pricing: dict | None = None,
        transcripts_dir: Path | None = None,
        keep_workdirs: bool = False,
        **kwargs: Any,
    ) -> None:
        self.bundle, self.split, self.task_ids = bundle, split, task_ids
        self.action_budget, self.time_budget, self.seed = action_budget, float(time_budget), seed
        self.sandbox, self.venv = sandbox, Path(venv)
        self.work_root = sandbox.prepare_root(Path(work_root))
        self.grader = Grader(bundle, sandbox, self.venv, self.work_root)
        self.pricing = pricing or {}
        self.transcripts_dir = Path(transcripts_dir) if transcripts_dir else None
        self.keep_workdirs = keep_workdirs
        self.max_idle_turns = MAX_IDLE_TURNS
        self.harness_digest = harness_digest()
        self.prompt_digest = prompt_digest()
        self.tools_digest = bundle.tools_digest()
        rows = [
            {
                "prompt": [{"role": "system", "content": SYSTEM_PROMPT}],
                "example_id": i,
                "answer": "",
                "info": json.dumps({"taskId": t, "split": split, "environmentId": bundle.environment_id}),
            }
            for i, t in enumerate(task_ids)
        ]
        dataset = Dataset.from_list(rows)
        super().__init__(
            dataset=dataset,
            eval_dataset=dataset,
            rubric=HiddenTestsRubric(self),
            tool_defs=[Tool(**d) for d in bundle.tool_definitions()],
            max_turns=action_budget + EXTRA_MODEL_CALLS,
            timeout_seconds=self.time_budget + TIMEOUT_GRACE_SEC,
            sampling_args={"temperature": 0.0, "seed": seed},
            env_id="envmarket_coding",
            **kwargs,
        )

    # ------------------------------------------------------------------ episode lifecycle
    async def setup_state(self, state: vf.State) -> vf.State:
        info = state["info"] if isinstance(state["info"], dict) else json.loads(state["info"])
        ep = Episode(task_id=info["taskId"], split=self.split, started_at=now_iso())
        state["em"] = ep
        try:
            ep.scratch = Path(tempfile.mkdtemp(prefix=f"ep-{ep.task_id}-", dir=self.work_root))
            if self.sandbox.kind == "unshare":
                ep.scratch.chmod(0o711)
            kit = build_kit(ep.scratch, self.bundle, self.split, ep.task_id, with_hidden=False)
            epdir = ep.scratch / "ep"
            epdir.mkdir()
            ep.workdir = epdir / "w"
            uid = self.sandbox.next_uid()
            self.sandbox.grant(kit, uid, False)
            self.sandbox.grant(epdir, uid, True)
            extra = {"TMPDIR": str(epdir), "HOME": str(epdir)} if self.sandbox.kind == "unshare" else None
            cmd = self.sandbox.command(self.venv, self.bundle.python_args("serve", {}), kit, [kit], [epdir], uid, self.time_budget + 120, extra)
            ep.server = EnvServer(cmd, self.sandbox)
            await ep.server.start()
            reset = await ep.server.call(
                {"cmd": "reset", "taskId": ep.task_id, "seed": self.seed, "workdir": str(ep.workdir), "actionBudget": self.action_budget, "timeBudgetSec": self.time_budget},
                RESET_TIMEOUT_SEC,
            )
            if not reset.get("ok"):
                raise RuntimeError(f"env reset failed: {(reset.get('error') or {}).get('message', reset)}")
            ep.reset_ok = True
            ep.deadline = time.monotonic() + self.time_budget
            task_msg = render_task_message(reset["observation"], self.bundle.terminal_tool.name)
            state["prompt"] = [SystemMessage(content=SYSTEM_PROMPT), UserMessage(content=task_msg)]
        except Exception as e:  # infra: surfaced as state["error"], graded as 0
            raise vf.InfraError(f"episode setup failed: {type(e).__name__}: {e}") from e
        return state

    async def get_model_response(self, state: vf.State, prompt: vf.Messages, *args: Any, **kwargs: Any):
        try:
            return await super().get_model_response(state, prompt, *args, **kwargs)
        except vf.ModelError as e:
            # A provider that rejects `seed` (HTTP 400 naming it): drop it, record seedSent=false.
            sa = dict(state.get("sampling_args") or {})
            text = f"{e} {e.__cause__}".lower()
            if "seed" in sa and "seed" in text and ("400" in text or "bad request" in text or "invalid" in text):
                sa.pop("seed")
                state["sampling_args"] = sa
                state["em"].seed_sent = False
                return await super().get_model_response(state, prompt, *args, **kwargs)
            raise

    async def env_response(self, messages: vf.Messages, state: vf.State, **kwargs: Any) -> vf.Messages:
        ep: Episode = state["em"]
        calls = getattr(messages[-1], "tool_calls", None) or []
        if not calls:
            ep.idle += 1
            return [UserMessage(content=NUDGE)]
        ep.idle = 0
        out: list = []
        for tc in calls:
            content = await self._run_tool_call(ep, tc.name, tc.arguments)
            if len(content) > TOOL_RESULT_MAX_CHARS:
                content = content[:TOOL_RESULT_MAX_CHARS] + "…[truncated]"
            out.append(ToolMessage(tool_call_id=tc.id, content=content))
        if ep.done:
            state["final_env_response"] = out
        return out

    async def _run_tool_call(self, ep: Episode, name: str, raw_args: str | None) -> str:
        if ep.done:
            return json.dumps({"ok": False, "error": "the episode has ended"})
        tool = self.bundle.tool_by_name.get(name)
        if tool is None:
            ep.actions.append({"type": name, "ok": False})
            return json.dumps({"ok": False, "error": f"unknown tool {name!r}; available: {sorted(self.bundle.tool_by_name)}"})
        try:
            args = json.loads(raw_args) if raw_args and raw_args.strip() else {}
            if not isinstance(args, dict):
                raise ValueError(f"expected a JSON object, got {type(args).__name__}")
        except Exception as e:
            ep.actions.append({"type": name, "ok": False})
            return json.dumps({"ok": False, "error": f"invalid JSON arguments: {e}"})
        action = {self.bundle.discriminator: tool.name, **{k: args[k] for k in tool.arg_names if k in args}}
        try:
            resp = await ep.server.call({"cmd": "step", "workdir": str(ep.workdir), "action": action}, STEP_TIMEOUT_SEC)
        except Exception as e:
            raise vf.InfraError(f"env step failed: {e}") from e
        if not resp.get("ok"):
            err = resp.get("error") or {}
            if err.get("code") == "episode_done":
                ep.done = True
            ep.actions.append({"type": name, "ok": False})
            return json.dumps({"ok": False, "error": err.get("message", "error")})
        ep.done = bool(resp.get("done"))
        ep.termination = resp.get("termination")
        ep.actions_used = int(resp.get("actionsUsed") or 0)
        obs = dict(resp.get("observation") or {})
        entry = {"type": name, "ok": bool(obs.get("ok"))}
        if isinstance(action.get("path"), str):
            entry["path"] = action["path"]
        ep.actions.append(entry)
        obs.update(actionsRemaining=resp.get("actionsRemaining"), done=resp.get("done"), termination=resp.get("termination"))
        return json.dumps(obs)

    @vf.stop
    async def idle_limit_reached(self, state: vf.State) -> bool:
        ep = state.get("em")
        if not ep or not state["trajectory"]:
            return False
        last = state["trajectory"][-1]["completion"][-1]
        no_tools = getattr(last, "role", None) == "assistant" and not getattr(last, "tool_calls", None)
        return no_tools and ep.idle + 1 >= self.max_idle_turns

    @vf.stop
    async def time_budget_exhausted(self, state: vf.State) -> bool:
        ep = state.get("em")
        return bool(ep and ep.deadline and time.monotonic() >= ep.deadline)

    @vf.cleanup
    async def close_env_server(self, state: vf.State) -> None:
        ep = state.get("em")
        if ep and ep.server:
            await ep.server.close()
            ep.server = None

    # ------------------------------------------------------------------ scoring + record
    async def score_episode(self, state: vf.State) -> float:
        ep: Episode | None = state.get("em")
        if ep is None:
            return 0.0
        grade, grade_error, final_files = None, None, {}
        if ep.reset_ok and ep.workdir is not None:
            try:
                grade = await self.grader.grade(ep.task_id, self.split, ep.workdir / "workspace", ep.termination or "incomplete", ep.scratch)
                for rel in (grade.get("diagnostics") or {}).get("editedFiles") or []:
                    p = ep.workdir / "workspace" / rel
                    if p.is_file():
                        final_files[rel] = p.read_text(encoding="utf-8", errors="replace")
            except Exception as e:
                grade_error = f"grading failed: {type(e).__name__}: {e}"
        record = self._record(state, ep, grade, grade_error, final_files)
        state["em_record"] = record
        return float(record["score"])

    def _record(self, state: vf.State, ep: Episode, grade: dict | None, grade_error: str | None, final_files: dict) -> dict:
        err = state.get("error")
        infra, error = False, None
        if err is not None:
            error = f"{type(err).__name__}: {err}" + (f" (cause: {type(err.__cause__).__name__}: {err.__cause__})" if err.__cause__ else "")
            infra = not isinstance(err, (InvalidModelResponseError, OverlongPromptError))
        if grade_error:
            error, infra = (error + "; " if error else "") + grade_error, True
        usage = self.get_state_usage(state) or {}
        prompt_toks, completion_toks = int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0))
        served: list[str] = []
        for step in state.get("trajectory") or []:
            m = getattr(step.get("response"), "model", None)
            if m and m not in served:
                served.append(m)
        requested = state["model"]
        price = self.pricing.get(served[-1] if served else requested) or self.pricing.get(requested)
        cost = None
        if price:
            cost = round(prompt_toks * float(price["inputUsdPerMTok"]) / 1e6 + completion_toks * float(price["outputUsdPerMTok"]) / 1e6, 6)
        messages = [m.model_dump(exclude_none=True) if hasattr(m, "model_dump") else m for m in [*(state.get("prompt") or []), *(state.get("completion") or [])]]
        transcript_hash = sha256_hex(canonical_json(messages))
        score = int(grade["score"]) if grade else 0
        d = (grade or {}).get("diagnostics") or {}
        sa = state.get("sampling_args") or {}
        record = {
            "type": "episode",
            "episodeId": f"{self.bundle.environment_id}:{self.split}:{ep.task_id}:{requested}",
            "environmentId": self.bundle.environment_id,
            "environmentVersion": self.bundle.environment_version,
            "taskId": ep.task_id,
            "split": self.split,
            "requestedModel": requested,
            "model": served[-1] if served else requested,
            "servedModels": served,
            "status": "infra_failure" if infra else ("succeeded" if score == 1 else "failed"),
            "solved": score == 1,
            "score": score,
            "termination": (grade or {}).get("termination") or ep.termination or "incomplete",
            "stopCondition": state.get("stop_condition"),
            "actionsUsed": ep.actions_used,
            "actions": ep.actions,
            "llmCalls": len(state.get("trajectory") or []),
            "usage": {"prompt": prompt_toks, "completion": completion_toks},
            "costUsd": cost,
            "seed": self.seed,
            "seedSent": ep.seed_sent,
            "sampling": {k: sa.get(k) for k in ("temperature", "seed", "max_tokens") if k in sa},
            "startedAt": ep.started_at,
            "finishedAt": now_iso(),
            "durationSec": round(time.monotonic() - ep.t0, 3),
            "grade": None
            if grade is None
            else {
                "score": score,
                "success": bool(grade.get("success")),
                "termination": grade.get("termination"),
                "passed": grade.get("passed"),
                "failed": grade.get("failed"),
                "collected": d.get("collected"),
                "allHiddenTestsPassed": bool(d.get("allHiddenTestsPassed")),
                "timedOut": bool(d.get("timedOut")),
                "editedFiles": d.get("editedFiles") or [],
                "gradedTreeDigest": d.get("gradedTreeDigest"),
                "graderVersion": d.get("graderVersion"),
            },
            "finalFiles": final_files,
            "transcriptHash": transcript_hash,
            "error": error[:1000] if error else None,
            "harness": {"id": HARNESS_ID, "harnessDigest": self.harness_digest, "promptDigest": self.prompt_digest, "toolsDigest": self.tools_digest, "verifiersVersion": vf.__version__},
            "sandbox": self.sandbox.describe(),
        }
        if self.transcripts_dir:
            self.transcripts_dir.mkdir(parents=True, exist_ok=True)
            safe = record["episodeId"].replace("/", "_").replace(":", "__")
            (self.transcripts_dir / f"{safe}.json").write_text(json.dumps({"episodeId": record["episodeId"], "transcriptHash": transcript_hash, "messages": messages}, indent=1, default=str))
        return record


def load_environment(
    bundle_dir: str,
    task_ids: list[str] | str | None = None,
    split: str = "purchased",
    action_budget: int = 12,
    time_budget: float = 600,
    seed: int = 0,
    sandbox: str = "docker",
    audit_dir: str | None = None,
    image: str = DEFAULT_PY_IMAGE,
    venv: str | None = None,
    netdeny: str | None = None,
    grader_python: str | None = None,
    work_dir: str | None = None,
    cache_dir: str | None = None,
    pricing: dict | None = None,
    transcripts_dir: str | None = None,
    keep_workdirs: bool = False,
    **kwargs: Any,
) -> EnvMarketCodingEnv:
    """Load an EnvMarket coding bundle as a verifiers environment (one dataset row per task).

    bundle_dir     purchased payload (manifest.json at the root) or a seller workspace
    task_ids       list or comma-separated string; default: every task of the split
    split          "purchased" (<bundle>/tasks) or "audit" (audit_dir, default <bundle>/audit-tasks)
    sandbox        docker | unshare | none (see sandbox.py); venv = an existing grader venv
    """
    b = Bundle(bundle_dir, audit_dir)
    available = b.task_ids(split)
    if task_ids is None or task_ids == "" or task_ids == []:
        ids = available
    else:
        ids = [t.strip() for t in task_ids.split(",")] if isinstance(task_ids, str) else [str(t) for t in task_ids]
    missing = [t for t in ids if t not in available]
    if missing:
        raise ValueError(f"unknown {split} task ids {missing}; available: {available}")
    sb = Sandbox(sandbox, image=image, netdeny=netdeny, grader_python=grader_python)
    work_root = Path(work_dir).resolve() if work_dir else default_work_root()
    cache_root = Path(cache_dir).resolve() if cache_dir else work_root / "cache"
    venv_path = Path(venv).resolve() if venv else sb.prepare_venv(cache_root, b.requirements_lock())
    return EnvMarketCodingEnv(
        bundle=b,
        split=split,
        task_ids=ids,
        action_budget=action_budget,
        time_budget=time_budget,
        seed=seed,
        sandbox=sb,
        venv=venv_path,
        work_root=work_root,
        pricing=pricing,
        transcripts_dir=Path(transcripts_dir) if transcripts_dir else None,
        keep_workdirs=keep_workdirs,
        env_args={"bundle_dir": str(b.root), "split": split, "task_ids": ids, "action_budget": action_budget, "time_budget": time_budget, "seed": seed, "sandbox": sandbox},
        **kwargs,
    )
