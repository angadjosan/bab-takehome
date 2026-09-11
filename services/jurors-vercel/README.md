# services/jurors-vercel: the AI jurors on Vercel

The three EnvMarket AI jurors, as Vercel Functions plus [Vercel Workflow](https://vercel.com/docs/workflows). One durable workflow run per FalseDescription dispute. Nothing runs on a laptop and nothing polls between disputes: a dispute wakes the service, and the run sleeps (durably, at no compute cost) between chain deadlines.

It runs the same juror logic as the reference processes in [`services/jurors`](../jurors/README.md): prompt `juror-v1` (same bytes, same sha256), the same case-packet fetch and EIP-191 evidence auth, the same strict verdict parsing and rationale screening, the same commitment encoding and the same pinned Fireworks models (juror1 `deepseek-v4p1-flash`, juror2 `gpt-oss-120b`, juror3 `glm-5p2`). Those modules are copied byte for byte into `src/vendor/` by `scripts/sync-vendor.mjs`; `npm test` and the deploy script fail if the copies drift.

## How a dispute is handled

```
buyer opens a FalseDescription dispute
  └─ web app / buyer agent CLI ── POST /api/wake {disputeId}   (daily Vercel Cron sweep as a safety net)
       └─ reads the chain: disputes 1..nextDisputeId-1, unresolved FalseDescription ones without a live run
            └─ start(jurorDisputeWorkflow) ── one run per dispute (hook token = lock)
                 loop: read chain snapshot → plan (pure) → run steps → durable sleep
                   select jurors (keeper) once block > selectionBlock
                   per seated juror of ours, in parallel:
                     fetch case packet from the TEE (EIP-191 auth) → fixed rubric on Fireworks → screen
                     prepare (verdict + commitment recorded) → commitVote → wait
                     revealVote (as soon as all 3 committed, else after commitDeadline)
                     POST /rationales/:disputeId to the TEE (after the reveal is on-chain)
                   tallyDispute (keeper) once all revealed or revealDeadline passed
                   round 2 / no-quorum fallback handled by the same loop
                   resolved → withdraw each juror's rewards → run ends
```

`src/lib/planner.ts` is the whole state machine as a pure function of (chain snapshot, memory). `src/lib/driver.ts` is the loop, and `src/workflows/dispute.ts` wires it to durable steps (`src/workflows/steps.ts`) and `sleep`. Every step re-reads the chain before acting.

## Safety properties

- **No double commit.** The commit step reads the seat first and does nothing if it already holds a commitment. The contract also rejects a second commit (`AlreadyCommitted`).
- **Always able to reveal.** The vote salt is derived, not stored: `salt = HMAC-SHA256(juror key, "envmarket.juror-vote-salt.v1|chainId|market|disputeId|round|juror")`. It is unpredictable without the key, and any later run recomputes it exactly, whether after a crash, a redeploy, or a lost or cancelled workflow run. With two possible verdicts, the reveal step recovers the verdict by matching the on-chain commitment. The verdict and commitment are fixed in a `prepareVote` step before the commit transaction is sent. The salt itself never appears in a log, a database or the workflow event log.
- **Nonce safety.** One juror key per step, one transaction per key at a time within a run, and every transaction waits for its receipt. Concurrent runs for different disputes can still collide on a nonce. The losing step returns "not applied" and the loop retries after re-reading the chain.
- **Deadlines.** The three deliberations run in parallel. Each is cut off about 12 s before the commit deadline, within the 300 s Hobby function limit. A juror that cannot decide in time abstains and takes the non-reveal slash, as the reference jurors do.
- **Kill switch.** Unless `JURORS_ENABLED=1`, `/api/wake` only reports what it would do, and every transaction step refuses to send.

## Endpoints

| Route | What |
|---|---|
| `GET /api/health` | Juror addresses, approval, stake (total/locked/free), claimable, gas balance, model pins, prompt hash, `enabled`. No secrets: only booleans for "key configured". |
| `POST /api/wake` | Body `{"disputeId"?: "12"}`. Idempotent. It reads the chain and starts a run for each unresolved FalseDescription dispute that has none. With nothing pending it answers `"nothing to do"`. CORS allows `https://rl-env-market.vercel.app` (`ALLOWED_ORIGINS`). Rate limited per IP (12/min) and per instance (120/min). |
| `GET /api/cron/sweep` | Same sweep, triggered by Vercel Cron. Needs `Authorization: Bearer $CRON_SECRET`, which Vercel sends. |
| `/.well-known/workflow/v1/*` | Workflow runtime routes (generated). |

## Configuration (Vercel project `rl-env-market-jurors`)

| Var | Notes |
|---|---|
| `JUROR1_PK`, `JUROR2_PK`, `JUROR3_PK` | Juror wallet keys. **Sensitive** env vars, production only. Only this project holds them; the public web project does not. |
| `FIREWORKS_API_KEY` | Inference. Sensitive. |
| `CRON_SECRET` | Random string. Vercel Cron sends it as a bearer token. Sensitive. |
| `JURORS_ENABLED` | `1` to act on-chain. Anything else means dry run. |
| `CHAIN_ID`, `RPC_URL`, `MARKET_ADDRESS`, `START_BLOCK`, `TEE_URL`, `KEEPER_JUROR`, `ALLOWED_ORIGINS` | Optional. Defaults: Base Sepolia, `https://sepolia.base.org`, `deployments/84532.json`, the live Phala TEE, juror 1 pays keeper gas, and the web origin. |

One-time setup, run from a linked checkout of this directory. Values are piped from the repo `.env` and never echoed:

```bash
for n in JUROR1_PK JUROR2_PK JUROR3_PK FIREWORKS_API_KEY; do
  node -e 'const m=require("fs").readFileSync("../../.env","utf8").match(new RegExp("^(?:export )?"+process.argv[1]+"=(.*)$","m"));process.stdout.write((m?m[1]:"").trim().replace(/^["\x27]|["\x27]$/g,""))' "$n" \
    | vercel env add "$n" production --sensitive
done
openssl rand -hex 32 | vercel env add CRON_SECRET production --sensitive
printf 1 | vercel env add JURORS_ENABLED production
```

## Deploy and verify

```bash
scripts/deploy-jurors.sh                  # from the repo root: HEAD snapshot, vendor check, tests, deploy, smoke test
WRITE_RECORD=1 scripts/deploy-jurors.sh   # also writes deployments/jurors.json
curl -s https://rl-env-market-jurors.vercel.app/api/health
curl -s -X POST https://rl-env-market-jurors.vercel.app/api/wake -d '{}'
npx workflow inspect runs --backend vercel --project rl-env-market-jurors   # runs, steps, sleeps
```

Local: `npm install && npm test` (unit tests: planner, a driver simulation against a fake EnvMarket including crash recovery and round 2, salt/commitment cross-checks against `cast`, vendor sync). `npm run build` also builds the workflow bundles. `npm run dev` uses the local Workflow world.

## Plan limits (Hobby, verified 2026-09-11)

- Workflow is included on Hobby: 50,000 events/month and 1 GB written. Run state is kept for 1 day after a run completes. There is no limit on `sleep` duration or run duration. A dispute costs a few hundred events, depending on how long it waits.
- Functions: 300 s max duration (Fluid compute). That bounds each step, not the run.
- Vercel Cron on Hobby runs at most once a day, so the cron is only a safety net. Wakes come from the web app and the CLI.
- Runtime logs are kept 1 hour on Hobby. The run's own result (`log` array) and the step history are in the Workflows dashboard for a day.

## Trust

The operator runs these jurors: one operator, three keys, three model families. They are no more independent than the laptop processes were. The keys are Vercel sensitive env vars: they cannot be read back from the dashboard or the CLI, but Vercel and anyone who can deploy to this project can use them. Step inputs and outputs, including each juror's verdict and commitment before the reveal (never the salt), are stored in Vercel's workflow event log. Members of the project can see them.
