"""pass@1 runner: every (model, task) pair gets exactly one episode through the verifiers environment.

    python -m envmarket_coding.run --bundle DIR --model accounts/fireworks/models/kimi-k3 \
        --tasks T1,T2 --seed 0 --temperature 0 --sandbox docker --out results.jsonl
    python -m envmarket_coding.run --digest [--bundle DIR]
    python -m envmarket_coding.run --regrade results.jsonl --bundle DIR [--audit-dir DIR] --out regrade.jsonl

stdout carries JSON lines only (one per finished episode, then one summary per model); logs go to
stderr. See harness/README.md for the record format and the TEE integration contract.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, TextIO

FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"


def _emit(obj: dict, out: TextIO | None) -> None:
    line = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    if out:
        out.write(line + "\n")
        out.flush()


def digest_info(bundle_dir: str | None, audit_dir: str | None, action_budget: int, time_budget: float) -> dict:
    from importlib.metadata import version

    from .digest import HARNESS_ID, harness_digest, prompt_digest
    from .environment import protocol_spec

    info: dict[str, Any] = {
        "type": "digest",
        "harnessId": HARNESS_ID,
        "harnessDigest": harness_digest(),
        "promptDigest": prompt_digest(),
        "verifiersVersion": version("verifiers"),
        "protocol": protocol_spec(action_budget, time_budget),
    }
    if bundle_dir:
        from .bundle import Bundle

        b = Bundle(bundle_dir, audit_dir)
        info.update(environmentId=b.environment_id, toolsDigest=b.tools_digest(), toolSource=b.tool_source, tools=b.tool_definitions())
    return info


def _summary(model: str, split: str, records: list[dict], t0: float) -> dict:
    n = len(records)
    solved = sum(1 for r in records if r.get("solved"))
    costs = [r.get("costUsd") for r in records]
    return {
        "type": "summary",
        "requestedModel": model,
        "servedModels": sorted({m for r in records for m in r.get("servedModels") or []}),
        "split": split,
        "episodes": n,
        "solved": solved,
        "pass1": round(solved / n, 4) if n else None,
        "infraFailures": sum(1 for r in records if r.get("status") == "infra_failure"),
        "usage": {"prompt": sum(r["usage"]["prompt"] for r in records), "completion": sum(r["usage"]["completion"] for r in records)},
        "costUsd": round(sum(costs), 6) if costs and all(c is not None for c in costs) else None,
        "wallSec": round(time.monotonic() - t0, 1),
    }


def _crash_record(env: Any, row: dict, model: str, error: str) -> dict:
    from .environment import now_iso

    info = json.loads(row["info"]) if isinstance(row["info"], str) else row["info"]
    return {
        "type": "episode",
        "episodeId": f"{env.bundle.environment_id}:{env.split}:{info['taskId']}:{model}",
        "environmentId": env.bundle.environment_id,
        "taskId": info["taskId"],
        "split": env.split,
        "requestedModel": model,
        "model": model,
        "servedModels": [],
        "status": "infra_failure",
        "solved": False,
        "score": 0,
        "termination": "incomplete",
        "actionsUsed": 0,
        "usage": {"prompt": 0, "completion": 0},
        "costUsd": None,
        "startedAt": now_iso(),
        "finishedAt": now_iso(),
        "grade": None,
        "finalFiles": {},
        "error": error[:1000],
        "harness": {"harnessDigest": env.harness_digest, "promptDigest": env.prompt_digest, "toolsDigest": env.tools_digest},
    }


async def run(args: argparse.Namespace) -> int:
    import verifiers as vf
    from openai import AsyncOpenAI

    from .environment import load_environment, parse_token_caps

    models =[m.strip() for spec in args.model for m in spec.split(",") if m.strip()]
    api_key = os.environ.get(args.api_key_env) or os.environ.get("LLM_API_KEY")
    if not api_key:
        print(f"error: set {args.api_key_env} (or LLM_API_KEY)", file=sys.stderr)
        return 2
    pricing = json.loads(Path(args.pricing).read_text()) if args.pricing else None
    env = load_environment(
        bundle_dir=args.bundle,
        task_ids=args.tasks,
        split=args.split,
        action_budget=args.action_budget,
        time_budget=args.time_budget,
        seed=args.seed,
        sandbox=args.sandbox,
        audit_dir=args.audit_dir,
        image=args.image,
        venv=args.venv,
        netdeny=args.netdeny,
        grader_python=args.grader_python,
        work_dir=args.work_dir,
        cache_dir=args.cache_dir,
        pricing=pricing,
        transcripts_dir=args.transcripts,
        keep_workdirs=args.keep_workdirs,
        max_episode_tokens=parse_token_caps(args.max_episode_tokens),
    )
    client = vf.OpenAIChatCompletionsClient(AsyncOpenAI(base_url=args.base_url, api_key=api_key, max_retries=args.max_retries, timeout=args.request_timeout))
    sampling = {"temperature": args.temperature, "seed": args.seed, "max_tokens": args.max_tokens}
    rows = env.get_eval_dataset().to_list()
    sem = asyncio.Semaphore(max(1, args.concurrency))
    out = open(args.out, "a" if args.append else "w", encoding="utf-8") if args.out else None
    t0 = time.monotonic()
    by_model: dict[str, list[dict]] = {m: [] for m in models}

    async def one(model: str, row: dict) -> dict:
        async with sem:
            try:
                o = await env.run_rollout(row, client, model, dict(sampling), max_retries=0, state_columns=["em_record"])
                rec = o.get("em_record")
                if not isinstance(rec, dict):
                    err = o.get("error")
                    rec = _crash_record(env, row, model, f"rollout produced no record: {err}")
                return rec
            except Exception as e:  # never drop an episode from the denominator
                logging.getLogger("envmarket_coding").exception("rollout crashed")
                return _crash_record(env, row, model, f"{type(e).__name__}: {e}")

    try:
        jobs = [asyncio.create_task(one(m, r)) for m in models for r in rows]
        for fut in asyncio.as_completed(jobs):
            rec = await fut
            by_model.setdefault(rec["requestedModel"], []).append(rec)
            _emit(rec, out)
        for m in models:
            _emit(_summary(m, env.split, by_model[m], t0), out)
    finally:
        if out:
            out.close()
        await client.close()
    return 0


async def regrade(args: argparse.Namespace) -> int:
    """Deterministic re-grade: rebuild each episode's final workspace from its stored `finalFiles`
    and grade it again with the hidden tests; the score and graded tree must match exactly."""
    from .bundle import Bundle
    from .environment import default_work_root
    from .grading import Grader
    from .sandbox import Sandbox

    bundle = Bundle(args.bundle, args.audit_dir)
    sb = Sandbox(args.sandbox, image=args.image, netdeny=args.netdeny, grader_python=args.grader_python)
    work_root = Path(args.work_dir).resolve() if args.work_dir else default_work_root()
    venv = Path(args.venv).resolve() if args.venv else sb.prepare_venv(Path(args.cache_dir).resolve() if args.cache_dir else work_root / "cache", bundle.requirements_lock())
    grader = Grader(bundle, sb, venv, work_root)
    records = [json.loads(ln) for ln in Path(args.regrade).read_text().splitlines() if ln.strip()]
    records = [r for r in records if r.get("type") == "episode" and r.get("grade") and r.get("environmentId") in (None, bundle.environment_id)]
    out = open(args.out, "w", encoding="utf-8") if args.out else None
    mismatches = 0
    try:
        for r in records:
            ws = Path(tempfile.mkdtemp(prefix="regrade-ws-", dir=sb.prepare_root(work_root)))
            for rel, text in (r.get("finalFiles") or {}).items():
                p = ws / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text, encoding="utf-8")
            try:
                g = await grader.grade(r["taskId"], r["split"], ws, r["grade"]["termination"])
                digest = (g.get("diagnostics") or {}).get("gradedTreeDigest")
                match = int(g["score"]) == int(r["score"]) and digest == r["grade"].get("gradedTreeDigest")
                res = {"score": int(g["score"]), "gradedTreeDigest": digest, "error": None}
            except Exception as e:
                match, res = False, {"score": None, "gradedTreeDigest": None, "error": f"{type(e).__name__}: {e}"}
            finally:
                import shutil

                shutil.rmtree(ws, ignore_errors=True)
            mismatches += 0 if match else 1
            _emit(
                {
                    "type": "regrade",
                    "episodeId": r.get("episodeId"),
                    "taskId": r["taskId"],
                    "split": r["split"],
                    "requestedModel": r.get("requestedModel"),
                    "originalScore": r["score"],
                    "originalGradedTreeDigest": r["grade"].get("gradedTreeDigest"),
                    "match": match,
                    **res,
                },
                out,
            )
        _emit({"type": "regrade_summary", "episodes": len(records), "mismatches": mismatches}, out)
    finally:
        if out:
            out.close()
    return 0 if mismatches == 0 else 1


def build_parser() -> argparse.ArgumentParser:
    from .sandbox import DEFAULT_PY_IMAGE

    p = argparse.ArgumentParser(prog="python -m envmarket_coding.run", description="EnvMarket pass@1 runner on the verifiers harness")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--digest", action="store_true", help="print harnessDigest / promptDigest (+ toolsDigest with --bundle) and exit")
    mode.add_argument("--regrade", metavar="RESULTS_JSONL", help="deterministically re-grade stored episodes")
    p.add_argument("--bundle", help="purchased payload dir (manifest.json) or seller workspace")
    p.add_argument("--audit-dir", help="audit tasks dir (default <bundle>/audit-tasks)")
    p.add_argument("--split", choices=["purchased", "audit"], default="purchased")
    p.add_argument("--model", action="append", default=[], help="model id; repeat or comma-separate for several")
    p.add_argument("--tasks", help="comma-separated task ids (default: every task of the split)")
    p.add_argument("--seed", type=int, default=0, help="env reset seed and sampling seed")
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--max-tokens", type=int, default=8192, help="max completion tokens per model call")
    p.add_argument(
        "--max-episode-tokens",
        action="append",
        default=[],
        help='cumulative per-episode token cap: "N" (prompt+completion) or "IN:OUT", optionally "MODEL=..." per model; repeatable. '
        "Enforced before each model call; the episode ends with termination token_budget (score 0)",
    )
    p.add_argument("--action-budget", type=int, default=12)
    p.add_argument("--time-budget", type=float, default=600, help="wall-clock seconds per episode")
    p.add_argument("--concurrency", type=int, default=4, help="episodes in flight")
    p.add_argument("--sandbox", choices=["docker", "unshare", "none"], default="docker")
    p.add_argument("--image", default=DEFAULT_PY_IMAGE, help="docker image for the grader (default: pinned python:3.12-slim)")
    p.add_argument("--venv", help="existing grader venv (skip installing requirements.lock)")
    p.add_argument("--netdeny", help="unshare mode: seccomp net-deny launcher (e.g. services/tee/runtime/netdeny.py)")
    p.add_argument("--grader-python", help="host python for the grader venv (unshare/none)")
    p.add_argument("--work-dir", help="scratch root (default <tmp>/envmarket-harness)")
    p.add_argument("--cache-dir", help="grader venv cache (default <work-dir>/cache)")
    p.add_argument("--base-url", default=os.environ.get("LLM_BASE_URL", FIREWORKS_BASE_URL))
    p.add_argument("--api-key-env", default="FIREWORKS_API_KEY")
    p.add_argument("--max-retries", type=int, default=3, help="transport-level HTTP retries (429/5xx); never episode retries")
    p.add_argument("--request-timeout", type=float, default=240)
    p.add_argument("--pricing", help='JSON file {modelId: {"inputUsdPerMTok": x, "outputUsdPerMTok": y}} for costUsd')
    p.add_argument("--out", help="also write the JSON lines here")
    p.add_argument("--append", action="store_true", help="append to --out instead of overwriting")
    p.add_argument("--transcripts", help="write full per-episode transcripts (private) to this dir")
    p.add_argument("--keep-workdirs", action="store_true")
    p.add_argument("--log-level", default="WARNING")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), stream=sys.stderr, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.digest:
        _emit(digest_info(args.bundle, args.audit_dir, args.action_budget, args.time_budget), None)
        return 0
    if not args.bundle:
        print("error: --bundle is required", file=sys.stderr)
        return 2
    if args.regrade:
        return asyncio.run(regrade(args))
    if not args.model:
        print("error: --model is required", file=sys.stderr)
        return 2
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
