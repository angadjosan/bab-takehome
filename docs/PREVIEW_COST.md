# Preview inference cost

This doc estimates what one marketplace PREVIEW run costs in inference, so the seller can be charged for it.
Measured 2026-09-10 on Fireworks serverless.

## What a preview calls

From `services/tee/src/preview.ts`, `harness.ts` and `validator.ts`:

- **Episodes.** Each panel model runs one episode per purchased task and per audit task.
  - The panel is `glm-5p3`, `kimi-k3` and `qwen3p8-max`.
  - Each episode starts from the system prompt, 5 tool schemas and the task message (about 1.1k tokens).
  - Every model call re-sends the whole history: assistant turns plus tool results, each result capped at 12,000 chars.
  - An episode allows up to 12 actions (submit is free) and at most 18 model calls (12 + `EXTRA_LLM_CALLS` 6).
  - Decoding uses `max_tokens` 8192, temperature 0 and seed 1337, with a 300 s wall clock per episode.
- **Validator.** One `json_object` call that reads the bundle's text files.
  - Solutions and audit tasks are excluded.
  - Each file is capped at 12,000 chars and the whole input at 180,000 chars.
  - `max_tokens` is 8192.
- **Episode counts.**
  - py-repair-kit: 3 × (5 + 2) = **21 episodes**.
  - humanevalfix-8: 3 × (8 + 2) = **30 episodes**.

## Measurements

**Source 1: the full py-repair-kit preview that already ran locally.** This was the local-dev e2e run in
`agents/.data/local-run/20260910-230157/tee-data`. I decrypted its sealed `private/runs` and `private/episodes`
records read-only, using the RUNNER_PK-derived storage key. The run completed all 21 episodes (all submitted) in 239 s.
The TEE records `usage.promptTokens/completionTokens` per episode.

| Model | Episodes | Mean prompt tok | Mean completion tok | Max prompt | Max completion | Mean calls |
|---|---|---|---|---|---|---|
| GLM 5.3 (`glm-5p3`) | 7 | 23,298 | 5,515 | 46,806 | 14,941 | 6.1 |
| Kimi K3 (`kimi-k3`) | 7 | 13,901 | 1,835 | 26,797 | 2,508 | 4.7 |
| Qwen 3.8 (`qwen3p8-max`) | 7 | 26,660 | 4,478 | 41,924 | 8,554 | 6.1 |

Completion tokens include reasoning tokens, which Fireworks bills as output. Context grows by roughly 1.3–1.6k prompt
tokens per call, measured as the worst episode per model under a linear-growth fit.

**Source 2: validation episodes.** I ran one harness-equivalent episode per model on py-repair-kit T3 (medium). The
script is a throwaway copy of the harness loop that drives `python -m grader.env reset/step/grade`, and it records raw
per-call `usage`.

| Model | Calls | Prompt | Completion | Cached prompt | Uncached $ | Billed $ with cache |
|---|---|---|---|---|---|---|
| GLM 5.3 | 6 | 22,499 | 4,366 | 17,150 (76%) | 0.0507 | 0.0312 |
| Kimi K3 | 4 | 10,900 | 1,743 | 6,977 (64%) | 0.0588 | 0.0400 |
| Qwen 3.8 | 7 | 31,249 | 10,978 | 23,358 (75%) | 0.1284 | 0.0875 |

These T3 numbers match the T3 episodes from source 1: GLM 19,669 / 8,187, Kimi 10,780 / 2,508, Qwen 40,127 / 8,554.
Fireworks prompt caching is automatic and hits heavily because every call re-sends the same prefix. The cache
discount is **not** in the quote, because hits are not guaranteed across replicas at concurrency 6. On T3, caching
cut the input bill by about 60% and the total bill by 32–38%.

**Source 3: validator.** I made one call per kit with the exact TEE validator input, built by importing
`buildValidatorInput`/`collectFiles` from `validator.ts`.

| Kit | Input chars | Prompt tok | Completion tok (reasoning) | $ |
|---|---|---|---|---|
| py-repair-kit | 135,934 | 38,949 | 1,475 (1,090) | 0.0573 |
| humanevalfix-8 | 142,922 | 40,840 | 2,660 (2,171) | 0.0644 |

That is about 3.5 chars per token. The quote uses 3.4 to stay conservative.

**The validator is broken as configured.** `accounts/fireworks/models/deepseek-v4-pro`, the `MODELS.validator` in
`packages/shared/src/llm.ts`, appears in `GET /models`, so `resolveModels` accepts it. But chat completions return
`404 Model not found, inaccessible, and/or not deployed`, and its model page says serverless is "Not supported".
The local preview's validator failed with exactly this error. The serverless id is
`accounts/fireworks/models/deepseek-v4-pro-0813`: it works, and the numbers above come from it. Either set
`VALIDATOR_MODEL` to that id or change the constant.

No humanevalfix-8 preview has run yet. Its episodes are estimated with the py-repair-kit per-episode means. Its
source files are about 1 KB each versus 2–4 KB for py-repair-kit, so this estimate is conservative.

## Prices

Fireworks serverless, standard tier, USD per 1M tokens, fetched 2026-09-10.

| Model | Input | Cached input | Output | Source |
|---|---|---|---|---|
| `glm-5p3` | 1.40 | 0.26 | 4.40 | https://fireworks.ai/models/fireworks/glm-5p3 |
| `kimi-k3` | 3.00 | 0.30 | 15.00 | https://fireworks.ai/models/fireworks/kimi-k3 |
| `qwen3p8-max` | 2.00 | 0.25 | 6.00 | https://fireworks.ai/models/fireworks/qwen3p8-max |
| `deepseek-v4-pro-0813` (validator) | 1.32 | 0.044 | 3.96 | https://docs.fireworks.ai/serverless/pricing ("DeepSeek V4 Pro (0813)") |

- `deepseek-v4-pro` itself has no serverless price because it is not served (https://fireworks.ai/models/fireworks/deepseek-v4-pro).
- The model pages and the docs page agree.
- https://fireworks.ai/pricing no longer lists LLM prices; it links to the docs page.
- Batch inference costs 50% of these prices but does not apply to interactive previews.

## Cost

These figures are uncached, at list prices.

**Per episode:**

| Model | Mean | Observed max | Full 12-action budget¹ | Hard protocol ceiling² |
|---|---|---|---|---|
| GLM 5.3 | $0.057 | $0.131 | $0.283 | $3.57 |
| Kimi K3 | $0.069 | $0.118 | $0.480 | $8.48 |
| Qwen 3.8 | $0.080 | $0.135 | $0.386 | $5.06 |
| **Per task (3 models)** | **$0.206** | $0.385 | $1.149 | $17.12 |

¹ One action per call, so 13 calls including submit. This uses each model's worst measured context growth per call
and worst output per call: GLM about 134k in / 21.6k out, Kimi 119k / 8.2k, Qwen 141k / 17.3k.

² 18 calls, each emitting 8,192 retained tokens, with all 12 tool results at the 12k-char cap. That is about 2.09M in /
147k out per episode. The 300 s time budget makes this unreachable, since 147k output tokens cannot be generated in
300 s. The ceiling only shows why the TEE needs its own token stop.

**Per preview:**

| Listing | Episodes | Expected | Observed-max (every task at the worst episode) | Full-budget worst case³ | Hard ceiling |
|---|---|---|---|---|---|
| py-repair-kit | 21 + validator | **$1.50** | $2.75 | **$8.15** | $120 |
| humanevalfix-8 | 30 + validator | **$2.13** | $3.91 | **$11.60** | $171 |

³ Full-budget episodes plus a validator at its ceiling: 180k chars / 3.4 ≈ 53k in, 8,192 out, $0.103.

## Recommended quote

```
episodeCost  = nTasks × Σ_models (expectedIn_m × in_m + expectedOut_m × out_m) / 1e6
                                           # nTasks = purchased + audit
validatorCost = (ceil(min(validatorInputChars, 180000) / 3.4) × vIn + 3000 × vOut) / 1e6
quote        = ceilToCent(episodeCost × 1.5 + validatorCost)       # USDC
worstCase    = nTasks × Σ_models (fullIn_m × in_m + fullOut_m × out_m) / 1e6
             + (ceil(180000 / 3.4) × vIn + 8192 × vOut) / 1e6
```

- `validatorInputChars` is `buildValidatorInput(...).length`, which the TEE already computes.
- If it isn't available before the run, use 180,000.

**Resulting quotes:**

| Listing | Episode cost | Validator | **Quote** | Worst-case bound |
|---|---|---|---|---|
| py-repair-kit | $1.468 | $0.065 | **$2.27** | $8.15 |
| humanevalfix-8 | $2.097 | $0.067 | **$3.22** | $11.60 |

**Why 1.5×:** it gives about 50% headroom over the expected uncached cost ($1.50 → $2.27 for py-repair-kit). It falls
short of the observed-max case ($2.75) only if *every* episode hits its model's worst run, and cache hits (32–38% of
the total bill on T3) cover most of that gap.

**To make worstCase a real bound rather than an estimate:**

- Have the TEE stop an episode, as an infra/budget failure, once its cumulative `prompt + completion` exceeds
  `fullIn_m + fullOut_m`.
- Alternatively, collect `worstCase` as a deposit and refund the difference against measured `usage`, which
  `EpisodeResult.usage` already carries.

**Constants for the TEE:**

```json
{
  "version": "envmarket.preview-cost.v1",
  "measuredAt": "2026-09-10",
  "currency": "USDC",
  "roundUpTo": 0.01,
  "safetyMargin": 1.5,
  "pricesUsdPerMTok": {
    "accounts/fireworks/models/glm-5p3":              { "in": 1.40, "cachedIn": 0.26,  "out": 4.40 },
    "accounts/fireworks/models/kimi-k3":              { "in": 3.00, "cachedIn": 0.30,  "out": 15.00 },
    "accounts/fireworks/models/qwen3p8-max":          { "in": 2.00, "cachedIn": 0.25,  "out": 6.00 },
    "accounts/fireworks/models/deepseek-v4-pro-0813": { "in": 1.32, "cachedIn": 0.044, "out": 3.96 }
  },
  "episodeTokens": {
    "accounts/fireworks/models/glm-5p3":     { "expectedIn": 24000, "expectedOut": 5600, "fullBudgetIn": 135000, "fullBudgetOut": 21600 },
    "accounts/fireworks/models/kimi-k3":     { "expectedIn": 14000, "expectedOut": 1900, "fullBudgetIn": 120000, "fullBudgetOut": 8200 },
    "accounts/fireworks/models/qwen3p8-max": { "expectedIn": 27000, "expectedOut": 4500, "fullBudgetIn": 141000, "fullBudgetOut": 17400 }
  },
  "validator": {
    "model": "accounts/fireworks/models/deepseek-v4-pro-0813",
    "charsPerToken": 3.4,
    "maxInputChars": 180000,
    "expectedOut": 3000,
    "maxOut": 8192
  }
}
```

**Caveats:**

- Temperature 0 does not make episode length deterministic across runs. For example, Qwen on T3 used 40k prompt tokens
  in the preview and 31k in the validation run.
- The per-episode constants come from one small-repo kit. Environments with larger files or longer test output push
  context growth toward the 12k-char tool-result cap. The quote should be re-measured when such a listing appears,
  from the `usage` stored in `private/runs`.
- If Fireworks changes prices, update `pricesUsdPerMTok`. The token constants stay valid.
