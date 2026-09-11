#!/usr/bin/env bash
# Full local run on anvil: chain + contracts + TEE service (local-dev mode, labeled none-local-dev)
# + three juror processes + the e2e story. Nothing touches a public network.
#
#   agents/demo/local.sh [--timeout-refund]
#
# Real inference: FIREWORKS_API_KEY from the repo .env is used by the TEE (reference panel +
# validator), the jurors and the buyer's claims audit. Without it, set LLM_PROVIDER=ollama
# for the TEE/jurors (local harness check) — the buyer falls back to Ollama automatically.
# Time travel: FAST_FORWARD=1 lets the orchestrator advance anvil time past the challenge window
# (anvil only). Logs: agents/.data/local-run/<ts>/{anvil,tee,jurors}.log
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS="$(dirname "$HERE")"
ROOT="$(dirname "$AGENTS")"
export PATH="$HOME/.foundry/bin:$PATH"
PORT_RPC="${ANVIL_PORT:-8545}"
PORT_TEE="${TEE_PORT:-8080}"
RUN="$AGENTS/.data/local-run/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"

# Load the repo .env for keys, then force the local chain for every child process.
set -a
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a
export CHAIN_ID=31337
export RPC_URL="http://127.0.0.1:$PORT_RPC"
export ANVIL_RPC="$RPC_URL"
export TEE_URL="http://127.0.0.1:$PORT_TEE"
export PUBLIC_URL="$TEE_URL"
export PORT="$PORT_TEE"
export AGENTS_DATA_DIR="$RUN/agents-data"
export FAST_FORWARD=1
unset MARKET_ADDRESS TOKEN_ADDRESS TOKEN_ADDR MNEMONIC || true

PIDS=()
# Kill a process and all its descendants (npx/tsx spawn nested node processes; killing only the
# subshell would leave the TEE and juror services running against the next run's chain).
killtree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do killtree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && killtree "$p"; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for d in "$AGENTS" "$ROOT/services/tee" "$ROOT/services/jurors"; do
  [ -d "$d/node_modules" ] || (echo "==> npm install in $d" && cd "$d" && npm install --no-audit --no-fund >/dev/null)
done

echo "==> anvil on :$PORT_RPC (1s blocks; logs $RUN/anvil.log)"
if curl -s -m 2 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null 2>&1; then
  echo "port $PORT_RPC already in use: stop the other node first" >&2
  exit 1
fi
anvil --port "$PORT_RPC" --block-time 1 --silent >"$RUN/anvil.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 30); do cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 0.5; done

echo "==> deploy contracts"
# deploy.sh always writes the shared deployments/31337.json; keep this run's copy private and put
# the shared file back exactly as it was (other builders may be using their own local chain).
SHARED_DEP="$ROOT/deployments/31337.json"
BACKUP=""
if [ -f "$SHARED_DEP" ]; then BACKUP="$RUN/deployments.31337.backup.json"; cp "$SHARED_DEP" "$BACKUP"; fi
(cd "$ROOT" && RPC="$RPC_URL" contracts/scripts/deploy.sh anvil) >"$RUN/deploy.log" 2>&1 || { cat "$RUN/deploy.log"; exit 1; }
mkdir -p "$RUN/deployments"
cp "$SHARED_DEP" "$RUN/deployments/31337.json"
if [ -n "$BACKUP" ]; then cp "$BACKUP" "$SHARED_DEP"; else rm -f "$SHARED_DEP"; rmdir "$ROOT/deployments" 2>/dev/null || true; fi
export DEPLOYMENTS_DIR="$RUN/deployments"
MARKET="$(node -e "console.log(require('$RUN/deployments/31337.json').market)")"
export MARKET_ADDRESS="$MARKET"
echo "    market $MARKET (deployment record: $RUN/deployments/31337.json)"

# In local dev the TEE signs with RUNNER_PK for all three roles (runner, relay, verifier).
TEE_SIGNER="$(cast wallet address --private-key "$RUNNER_PK")"
OWNER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
for fn in setRunner setRelay setVerifier; do
  cast send --rpc-url "$RPC_URL" --private-key "$OWNER_PK" "$MARKET" "$fn(address,bool)" "$TEE_SIGNER" true >/dev/null
done
for a in "$TEE_SIGNER" "$SELLER_ADDR" "$BUYER_ADDR" "$BUYER2_ADDR" "$JUROR1_ADDR" "$JUROR2_ADDR" "$JUROR3_ADDR"; do
  cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null
done
echo "    TEE signer $TEE_SIGNER is runner+relay+verifier"

echo "==> TEE service (local-dev) on :$PORT_TEE (logs $RUN/tee.log)"
if curl -s -m 2 "$TEE_URL/health" >/dev/null 2>&1; then
  echo "port $PORT_TEE already serves a TEE (a stale service from an earlier run?): stop it first" >&2
  exit 1
fi
(cd "$ROOT/services/tee" && DATA_DIR="$RUN/tee-data" TEE_MODE=local-dev npx tsx src/main.ts) >"$RUN/tee.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "$TEE_URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$TEE_URL/health" >/dev/null || { tail -40 "$RUN/tee.log"; exit 1; }

echo "==> jurors: register stake, then run all three (logs $RUN/jurors.log)"
for n in 1 2 3; do
  (cd "$ROOT/services/jurors" && JUROR_DATA_DIR="$RUN/juror-data" JUROR_INDEX=$n npx tsx src/juror.ts register --self-approve-local) >>"$RUN/jurors.log" 2>&1
done
(cd "$ROOT/services/jurors" && JUROR_DATA_DIR="$RUN/juror-data" npx tsx src/run-all.ts) >>"$RUN/jurors.log" 2>&1 &
PIDS+=($!)

echo "==> e2e"
cd "$AGENTS"
npx tsx demo/e2e.ts "$@" 2>&1 | tee "$RUN/e2e.log"
status=${PIPESTATUS[0]}
echo "==> logs in $RUN"
exit "$status"
