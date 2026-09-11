# EnvMarket reference harness (`harness/envmarket_coding`)

The marketplace runs its reference panel through this open-source harness. The TEE's preview runs
and its `PreviewNotReproducible` re-runs use it, and so can any buyer's own evaluation or RL pipeline.
It replaces the hand-rolled TypeScript tool loop (`services/tee/src/harness.ts` + `packages/shared`
`runToolLoop`). The TypeScript loop is being deleted; this subprocess is the only harness.

## What it is built on: Prime Intellect `verifiers` 0.3.1

[`verifiers`](https://github.com/PrimeIntellect-ai/verifiers) (MIT) is Prime Intellect's library of
RL environments. It packages the environment, the multi-turn rollout loop and the reward (a
*rubric*) as one Python object. Its trainer, [prime-rl](https://github.com/PrimeIntellect-ai/prime-rl)
(GRPO), consumes environments of this type directly, and `vf-eval` evaluates them. Any
OpenAI-compatible endpoint serves the model. We run Fireworks
(`https://api.fireworks.ai/inference/v1`).

Pinned version and API actually used (checked against the installed 0.3.1 source, not the docs):

| Piece | verifiers API (0.3.1, classic `import verifiers as vf` surface) |
|---|---|
| Environment | subclass of `vf.MultiTurnEnv`: `setup_state`, `env_response`, `get_model_response`, `@vf.stop` conditions, `@vf.cleanup` |
| Tools | `tool_defs=[vf.Tool(name, description, parameters)]`, generated from the manifest (below) |
| Reward | subclass of `vf.Rubric`: reward func `hidden_tests` (weight 1), metric `actions_used` (weight 0) |
| Model client | `vf.OpenAIChatCompletionsClient(openai.AsyncOpenAI(base_url, api_key))` |
| Running | `Environment.run_rollout(input, client, model, sampling_args, max_retries=0, state_columns=["em_record"])` per episode. `env.evaluate(...)` and `vf-eval` also work. |
| Loading | `load_environment(...)` in the package root. `vf.load_environment("envmarket_coding", ...)` / `vf-eval envmarket_coding` / prime-rl import it by module name |

Why these choices:
- **Not `vf.ToolEnv` or `vf.StatefulToolEnv`.** They build tool schemas from Python function
  signatures. We want the environment's manifest to define the interface, so we pass `tool_defs`
  to `MultiTurnEnv` and forward every tool call to the environment's own server.
- **Not the newer `verifiers.v1` stack.** In 0.3.1 it is a separate taskset/harness framework. The
  classic surface is what `vf-eval`, `vf.load_environment` and prime-rl's environment loading
  consume.
- **Not mini-swe-agent (the fallback we considered).** It was not needed: verifiers worked with
  Fireworks and both environments on the first try.

## How an episode runs

```
load_environment(bundle_dir, task_ids, split, action_budget=12, time_budget=600, seed=0, sandbox=docker)
  -> one dataset row per task
rollout (one per task, pass@1):
  setup_state   agent kit = src/ + grader/ + tasks/<id> WITHOUT hidden tests or solutions
                start `entrypoints.serve` (python -m grader.env serve) in the sandbox
                reset {taskId, seed, workdir, actionBudget, timeBudgetSec} -> fresh workspace
                user message rendered from the reset observation
  model <-> env each tool call -> one `step` action; tool message = observation + envelope
                (actionsRemaining, done, termination), truncated at 12,000 chars
                no tool call -> nudge ("Continue by calling one of the tools..."), max 3 in a row
  stop          env done (submit | budget_exhausted | timeout), 18 model calls (budget + 6),
                wall-clock budget, idle limit, or error
  rubric        `entrypoints.gradeArtifact` (python -m grader.grade) in a SEPARATE sandboxed
                process over a kit that has the hidden tests, workspace mounted read-only
                reward = grader score: 1 only if every hidden test passes AND termination == submitted
```

Budget exhaustion, timeout, no submit and infrastructure failures all score 0. There is exactly one
episode per (model, task): no retries and no best-of. The only retries are transport-level HTTP
retries in the OpenAI SDK (429/5xx/connection, `--max-retries 3`). The hidden tests are never inside
the agent's sandbox. That matters because agent-written code runs there during `run_visible_tests`.

## How the manifest drives the tools

Tools are generated from `manifest.schemas["action.jsonSchema"]` (added to both seller templates;
see the BUILD_SPEC change log). It is a JSON Schema `oneOf` with one branch per action,
discriminated by `type`:

```json
{"title": "read_file", "description": "Read one workspace file (the first 64 KiB).", "type": "object",
 "properties": {"type": {"const": "read_file"}, "path": {"type": "string", "description": "workspace-relative file path"}},
 "required": ["type", "path"], "additionalProperties": false, "x-terminal": false, "x-countsAgainstBudget": true}
```

The mapping from a branch to a tool:
- tool name = the `type` const
- tool parameters = the remaining properties and `required`
- description = the branch description, plus a generated budget note derived from
  `x-terminal` / `x-countsAgainstBudget`

A tool call `{name, arguments}` becomes the action `{"type": name, ...arguments}` sent to `step`.
Bundles without `action.jsonSchema` fall back to the loose `schemas.action.oneOf` notation
(`"string? (default '.')"`), with `submit` taken as the terminal action.
Entrypoints come from `entrypoints.spec.<name>.argv` (packaged manifest) or
`entrypoints.<name>.argv` (template). `toolsDigest` = sha256(canonical JSON of the generated tool
definitions) binds the exact interface the model saw.

## Install

```bash
cd harness/envmarket_coding
uv sync --frozen                    # Python 3.12 venv with the uv.lock pins (.venv/)
# or, without uv:
python3.12 -m venv .venv && .venv/bin/pip install --require-hashes -r requirements.lock
```

Run everything from `harness/envmarket_coding` (or put that directory on `PYTHONPATH`). The package
is not built or installed, so the only third-party code is the hash-pinned lock.

## Using the environment in your own RL pipeline

```python
import verifiers as vf
env = vf.load_environment(
    "envmarket_coding",                      # PYTHONPATH must include harness/envmarket_coding
    bundle_dir="/data/py-repair-kit",        # your decrypted purchased payload
    split="purchased", sandbox="docker",     # or "unshare" (Linux root) / "none" (dev only)
    action_budget=12, time_budget=600, seed=0,
)
# evaluation (what the marketplace reports):
res = env.evaluate_sync(client=vf.OpenAIChatCompletionsClient(openai.AsyncOpenAI(...)), model="...",
                        sampling_args={"temperature": 0, "seed": 0, "max_tokens": 8192},
                        rollouts_per_example=1, state_columns=["em_record"])
```

- **`vf-eval`:** `vf-eval envmarket_coding -a '{"bundle_dir": "/data/py-repair-kit"}' -m <model> -b <base_url> -k <API_KEY_ENV> -n 5 -r 1`
- **prime-rl / GRPO:** point the orchestrator's environment at id `envmarket_coding` with the same
  `args`. Use `rollouts_per_example > 1` for group advantages. `reward` is the 0/1 hidden-test
  score, and `trajectory` holds each turn's prompt/completion for token-level training.
  The reference report uses one rollout per task. Training can use any number.
- Episodes are independent: one workdir and one server per rollout, so they are safe to run
  concurrently.

## Integration contract for the TEE

### 1. Bind the harness (once per preview)

```bash
python -m envmarket_coding.run --digest --bundle <payloadDir> [--action-budget 12 --time-budget 300]
```

stdout, one JSON line:

```json
{"type": "digest", "harnessId": "envmarket.harness.verifiers.v1", "harnessDigest": "0x…", "promptDigest": "0x…",
 "toolsDigest": "0x…", "toolSource": "schemas.action.jsonSchema", "tools": [...], "verifiersVersion": "0.3.1",
 "environmentId": "py-repair-kit", "protocol": {actionBudget, timeBudgetSec, maxModelCalls, maxIdleTurns,
 toolResultMaxChars, episodesPerTask, retries, successRule, failures, grading, loop, harness}}
```

Here is how the values map into the report:
- `harnessDigest` = sha256 of the canonical tar of `harness/envmarket_coding` (source +
  `pyproject.toml` + `uv.lock` + `requirements.lock`). It is the same canonical ustar as
  `packages/shared` `canonicalTarHashOfDir(dir, {excludeNames: [...DEFAULT_EXCLUDE_NAMES, '.venv', '.ruff_cache']})`.
- `promptDigest` = sha256(canonical JSON of {system, nudge, userTemplate}).
- Put `harnessDigest` → `protocol.harnessDigest`, `promptDigest` → the prompt digest, and hash
  `protocol` + `toolsDigest` + decoding settings into the published protocol spec.

### 2. Run the panel (preview, and the LLM re-run for PreviewNotReproducible)

One invocation per (model, split). Or pass several `--model` flags; each (model, task) is still one
episode.

```bash
FIREWORKS_API_KEY=… python -m envmarket_coding.run \
  --bundle <payloadDir> --split purchased|audit [--audit-dir <auditTaskSourceDir>] \
  --tasks T1,T2,…            # omit = every task of the split; re-run = the masked tasks
  --model accounts/fireworks/models/glm-5p3 \
  --seed 1337 --temperature 0 --max-tokens 8192 \
  --action-budget 12 --time-budget 300 --concurrency 6 \
  --sandbox docker|unshare [--netdeny services/tee/runtime/netdeny.py] \
  [--venv <gradeVenv>] [--work-dir <scratch>] [--pricing prices.json] \
  --out <private>/episodes.jsonl [--transcripts <private>/transcripts]
```

| Flag | Meaning |
|---|---|
| `--bundle` | Extracted purchased payload (must contain `manifest.json`, `src/`, `grader/`, `tasks/`, `requirements.lock`) |
| `--audit-dir` | Directory that holds `<A_id>/` audit task dirs (the TEE keeps them outside the payload). Default `<bundle>/audit-tasks` |
| `--seed` | Env `reset` seed AND sampling `seed`. A provider 400 that names `seed` → retried once without it, `seedSent: false` |
| `--temperature --max-tokens` | Decoding (sent as `temperature`, `seed`, `max_completion_tokens`) |
| `--max-episode-tokens` | Cumulative per-episode cap: `N` (prompt+completion) or `IN:OUT`, optionally `MODEL=IN:OUT` per model; repeatable. Checked before every model call against the exact next prompt (3 chars/token estimate); `max_tokens` is capped at the remaining output budget. The episode then ends with `termination: "token_budget"` (score 0, not an infra failure; record field `tokenBudgetExhausted`). The TEE passes docs/PREVIEW_COST.md `fullBudgetIn:fullBudgetOut` per panel model |
| `--sandbox docker` | macOS / any Docker host: `--network none --read-only --tmpfs /tmp --tmpfs /work --cpus 1 --memory 512m --pids-limit 128 --security-opt no-new-privileges --cap-drop ALL --user 65534`, pinned `python:3.12-slim@sha256:78387bc3…` |
| `--sandbox unshare` | Linux root (in-TEE): `unshare --net --pid --fork --mount-proc` when permitted, `setpriv` per-phase uid, `prlimit`, and the seccomp launcher from `--netdeny` (required when netns is unavailable; refuses to run with neither). There is no mount namespace, so sandboxed code sees the host filesystem. The harness therefore refuses to run unless `--bundle` and `--audit-dir` sit under a directory that denies others (no `o+x`, e.g. the TEE's 0700 data dir), and `--work-dir` / `--venv` are traversable (`o+x` on every ancestor; the default `<tmp>/envmarket-harness` is). |
| `--venv` | Reuse a grader venv (e.g. from the TEE's `prepareVenv`). Otherwise the harness installs `requirements.lock` (`--only-binary=:all: --require-hashes`) into `<work-dir>/cache/venv-<hash>` before any seller code runs. For `docker` the venv must have been built inside the same image. |
| `--api-key-env` / `--base-url` | Default `FIREWORKS_API_KEY` / `$LLM_BASE_URL` or Fireworks |
| `--pricing` | `{modelId: {"inputUsdPerMTok": x, "outputUsdPerMTok": y}}` → `costUsd` per episode. Without it `costUsd` is `null` |
| `--transcripts` | Full message transcripts (private). `transcriptHash` in the record commits to them either way |

stdout is JSON lines only, and logs go to stderr. Each episode prints one line as it finishes, in
completion order. After all episodes, one `summary` line per model. `--out` gets the same lines.
Exit code is 0 when the run completed, even if episodes failed. Failures are in the records. Exit
code 2 means usage/config error, or a sandbox that cannot be established. The TEE should treat any
non-zero exit, or a missing (model, task) record, as an infra failure for the affected episodes.

**Episode record** (`"type": "episode"`):

```json
{
  "type": "episode",
  "episodeId": "py-repair-kit:purchased:T1:accounts/fireworks/models/kimi-k3",
  "environmentId": "py-repair-kit", "environmentVersion": "py-repair-kit@1.0.0",
  "taskId": "T1", "split": "purchased",
  "requestedModel": "accounts/fireworks/models/kimi-k3",
  "model": "accounts/fireworks/models/kimi-k3",          // served id (last), from the API response
  "servedModels": ["accounts/fireworks/models/kimi-k3"],
  "status": "succeeded" | "failed" | "infra_failure",
  "solved": true, "score": 1,                             // 0/1 hidden-test grade (pass@1 unit)
  "termination": "submitted" | "budget_exhausted" | "timeout" | "incomplete",
  "stopCondition": "has_final_env_response",              // verifiers stop condition that fired
  "actionsUsed": 3, "actions": [{"type": "read_file", "path": "…", "ok": true}, …],
  "llmCalls": 4,
  "usage": {"prompt": 5384, "completion": 486},            // summed over the episode's model calls
  "costUsd": null,
  "seed": 0, "seedSent": true, "sampling": {"temperature": 0.0, "seed": 0, "max_tokens": 8192},
  "startedAt": "…Z", "finishedAt": "…Z", "durationSec": 18.9,
  "grade": {"score": 1, "success": true, "termination": "submitted", "passed": 1, "failed": 0,
            "collected": 1, "allHiddenTestsPassed": true, "timedOut": false,
            "editedFiles": ["hefix/below_zero.py"], "gradedTreeDigest": "0x…", "graderVersion": "1.0.0"},
  "finalFiles": {"hefix/below_zero.py": "…"},             // edited editable files, for re-grading
  "transcriptHash": "0x…",                                 // sha256(canonical JSON of all messages)
  "error": null,
  "harness": {"id": "envmarket.harness.verifiers.v1", "harnessDigest": "0x…", "promptDigest": "0x…",
              "toolsDigest": "0x…", "verifiersVersion": "0.3.1"},
  "sandbox": "docker python:3.12-slim@sha256:… --network none …"
}
```

`status` is `infra_failure` for sandbox/env-server/grading failures and API errors after transport
retries. Such episodes still count as attempted and not solved (`score: 0`), and `error` says why.
`grade`, `finalFiles` and the transcript are private (they contain task content). Publish
aggregates only.

**Summary** (`"type": "summary"`, one per `--model`):
`{requestedModel, servedModels, split, episodes, solved, pass1, infraFailures, usage{prompt,completion}, costUsd, wallSec}`.

Mapping onto the TEE's old `EpisodeResult`:

| Old field | New field |
|---|---|
| `model` | `requestedModel` |
| `servedModels` | `servedModels` |
| `set` | `split` |
| `status`, `solved`, `termination`, `actions`, `llmCalls`, `seedSent`, `startedAt`, `finishedAt`, `error`, `finalFiles`, `transcriptHash` | same names |
| `grade` | `grade` (a superset) |
| `usage.promptTokens` / `usage.completionTokens` | `usage.prompt` / `usage.completion` |

`jobId`, `requested` (panel label) and `provider` stay TEE-side. Key them by `(requestedModel, split, taskId)`.

### 3. Deterministic re-grade (PreviewNotReproducible, tolerance 0)

```bash
python -m envmarket_coding.run --regrade <private>/episodes.jsonl --bundle <payloadDir> \
  [--audit-dir <auditDir>] --sandbox docker|unshare [--netdeny …] --out regrade.jsonl
```

Each stored episode's `finalFiles` is written to an empty dir and graded again with the hidden
tests. The grader rebuilds the starting state and copies in only editable files, so the graded tree
is identical. Each episode prints a line
`{"type": "regrade", episodeId, taskId, split, requestedModel, originalScore, score, originalGradedTreeDigest, gradedTreeDigest, match, error}`.
The run ends with `{"type": "regrade_summary", episodes, mismatches}`. Exit code is 0 if every
episode matched, 1 otherwise.

The LLM re-run half of the check (±5 pp per model on the masked tasks) is step 2 again, with the same
arguments and `--tasks <masked ids>`. Compare per-model `pass1` from the summaries.

### Deterministic settings

`temperature 0`, fixed `seed` (sampling and env reset), fixed `max_tokens`, `action_budget 12`,
18 model calls, 3 idle nudges, 12,000-char tool results, one episode per task. These are all in
`--digest`'s `protocol` and in every record. Provider-side nondeterminism at temperature 0 remains;
that is why the LLM re-run has a tolerance and the grade re-run does not.

## Validation (real runs, Fireworks, Docker sandbox)

Run on 2026-09-11 against the committed harness. Settings: `--sandbox docker` (macOS, Docker 28.1),
seed 0, temperature 0, `max_tokens` 8192, action budget 12, time budget 600 s. Each (model, task)
got exactly one episode, with the three panel models on T1 and T2 of both environments.

```
harnessDigest  0xf32a231ca4ed659243683d334229a8869d6b30fb957480a2700519d6216da9d6
promptDigest   0x2c2030ea9a0296ff6c57e02b65abdfdb05aaaa4a608280d3a7187775f264736c
toolsDigest    0x92d0a2e259a73c09af0d454393077615b0cfb75d2d3d6c9e3efa1debd98e88d3  (py-repair-kit)
               0xe52a0caf0246fa968b33d3fc698409dd15023cea856370a692d694c3be71857e  (humanevalfix-8)
verifiers      0.3.1
```

| Environment | Model (requested → served) | Task | Score | Termination | Actions | Model calls | Prompt tok | Completion tok | Wall |
|---|---|---|---|---|---|---|---|---|---|
| py-repair-kit | glm-5p3 → glm-5p3 | T1 | 1 | submitted | 6 | 5 | 13,983 | 1,503 | 23s |
| py-repair-kit | glm-5p3 → glm-5p3 | T2 | 1 | submitted | 7 | 6 | 29,948 | 3,952 | 62s |
| py-repair-kit | kimi-k3 → kimi-k3 | T1 | 1 | submitted | 4 | 4 | 8,362 | 1,337 | 28s |
| py-repair-kit | kimi-k3 → kimi-k3 | T2 | 1 | submitted | 5 | 5 | 15,942 | 2,239 | 43s |
| py-repair-kit | qwen3p8-max → Qwen 3.8 Max | T1 | 1 | submitted | 6 | 5 | 14,075 | 1,280 | 15s |
| py-repair-kit | qwen3p8-max → Qwen 3.8 Max | T2 | 1 | submitted | 6 | 5 | 23,188 | 5,165 | 58s |
| humanevalfix-8 | glm-5p3 → glm-5p3 | T1 | 1 | submitted | 4 | 4 | 5,636 | 376 | 8s |
| humanevalfix-8 | glm-5p3 → glm-5p3 | T2 | 1 | submitted | 4 | 4 | 9,000 | 2,132 | 28s |
| humanevalfix-8 | kimi-k3 → kimi-k3 | T1 | 1 | submitted | 4 | 4 | 6,160 | 679 | 16s |
| humanevalfix-8 | kimi-k3 → kimi-k3 | T2 | 1 | submitted | 4 | 4 | 7,388 | 957 | 19s |
| humanevalfix-8 | qwen3p8-max → Qwen 3.8 Max | T1 | 1 | submitted | 4 | 4 | 7,096 | 1,351 | 24s |
| humanevalfix-8 | qwen3p8-max → Qwen 3.8 Max | T2 | 1 | submitted | 4 | 4 | 8,230 | 1,023 | 14s |
| **Total (12 episodes)** | | | **12/12** | | | | **149,008** | **21,994** | |

What these runs show, and what they don't:
- **Coverage.** Every episode ran the full path: manifest-generated tools, the `serve` subprocess in
  `docker --network none`, submit, then separate-process hidden-test grading. There were 0 infra
  failures and `seedSent` was true everywhere (Fireworks accepts `seed`).
- **Served model ids.** Fireworks reports the served `model` for `qwen3p8-max` as the display name
  `"Qwen 3.8 Max"`. The record keeps it verbatim in `model`/`servedModels`, next to
  `requestedModel`.
- **Deterministic re-grade.** `--regrade` on all 12 episodes gave 12/12 matches: same score and same
  `gradedTreeDigest`.
- **`costUsd`** is `null` because no `--pricing` file was passed. Token usage is exact, from the
  provider's `usage`.
- **Scores.** These tasks are easy for the panel, so every model scored 1. The run validates the
  harness, not the environments' difficulty.
- **`--sandbox unshare`.** Verified in Linux containers (`python:3.12-slim`, root) twice: once with
  `--privileged` (`unshare --net` path) and once unprivileged with `services/tee/runtime/netdeny.py`
  (seccomp path). Agent-written code ran as uid 40001 with sockets denied (`OSError` /
  `PermissionError`) and could not reach hidden tests. The guard refused a world-readable bundle.
  The graded score was 1.
