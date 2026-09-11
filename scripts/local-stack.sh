#!/usr/bin/env bash
# Local full stack for manual testing in the browser (anvil chain 31337, nothing public):
#   anvil → deploy contracts → sync ABIs into apps/web → TEE service (local-dev) → seller agent
#   lists py-repair-kit and gets a real signed preview (Fireworks) → three juror agents → web app.
#
#   scripts/local-stack.sh          # stays in the foreground; Ctrl-C stops everything it started
#
# Env knobs (all optional):
#   ANVIL_PORT=8546  TEE_PORT=8788  WEB_PORT=3100    ports (a port held by a process this script
#                                                    did not start is an error; it is never killed)
#   STACK_DIR=<repo>/.data/local-stack               state + logs (gitignored)
#   JURORS=1,2,3        juror agents to run. All three are always registered and staked, so a juror
#                       left out here can still be drawn and then votes manually in the web UI.
#   SKIP_PREVIEW=1      list without the (minutes-long, real-inference) preview
#   WEB=0               don't start `next dev` (its env is written to $STACK_DIR/web.env)
#   LISTING_PRICE=100 LISTING_COLLATERAL=100 (whole tUSDC), SELLER_WORKSPACE
#
# Idempotent: every run starts a fresh chain. Processes from a previous run of this script (pidfile in
# $STACK_DIR, matched by pid AND start time) are stopped first; nothing else is touched. deploy.sh's
# shared deployments/31337.json is restored afterwards, so the committed web build is unaffected: the
# web app gets this chain's addresses via NEXT_PUBLIC_MARKET_ADDRESS / NEXT_PUBLIC_START_BLOCK.
# Needs: foundry (anvil/forge/cast), node 22, docker (TEE sandbox), lsof, and in the repo .env:
# FIREWORKS_API_KEY plus the RUNNER/SELLER/BUYER/JUROR keys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
ANVIL_PORT="${ANVIL_PORT:-8546}"
TEE_PORT="${TEE_PORT:-8788}"
WEB_PORT="${WEB_PORT:-3100}"
STACK_DIR="${STACK_DIR:-$ROOT/.data/local-stack}"
PIDFILE="$STACK_DIR/pids"
LOGS="$STACK_DIR/logs"
PRICE="${LISTING_PRICE:-100}"
COLLATERAL="${LISTING_COLLATERAL:-100}"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

for bin in anvil forge cast node curl docker lsof; do command -v "$bin" >/dev/null || die "$bin not found on PATH"; done
[[ "$PRICE" =~ ^[0-9]+$ && "$COLLATERAL" =~ ^[0-9]+$ ]] || die "LISTING_PRICE / LISTING_COLLATERAL must be whole token units"

# ---------------------------------------------------------------- process bookkeeping
kill_tree() { # children first, then the process itself
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
started_at() { ps -p "$1" -o lstart= 2>/dev/null | tr -s ' ' '_' || true; }

stop_previous() {
  [ -f "$PIDFILE" ] || return 0
  local pid when name
  while read -r pid when name; do
    [ -n "$pid" ] || continue
    if [ -n "$when" ] && [ "$(started_at "$pid")" = "$when" ]; then
      echo "    stopping $name from the previous run (pid $pid)"
      kill_tree "$pid"
    fi
  done <"$PIDFILE"
  rm -f "$PIDFILE"
  sleep 1
}

STARTED=()
start_bg() { # name logfile cmd...
  local name="$1" log="$2"
  shift 2
  "$@" >"$log" 2>&1 &
  local pid=$!
  STARTED+=("$pid")
  echo "$pid $(started_at "$pid") $name" >>"$PIDFILE"
}

SHARED_DEP="$ROOT/deployments/31337.json"
DEP_BACKUP=""
DEP_TOUCHED=0
restore_deployment() {
  [ "$DEP_TOUCHED" = 1 ] || return 0
  if [ -n "$DEP_BACKUP" ]; then mv -f "$DEP_BACKUP" "$SHARED_DEP"; else rm -f "$SHARED_DEP"; rmdir "$ROOT/deployments" 2>/dev/null || true; fi
  DEP_TOUCHED=0
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  restore_deployment
  if ((${#STARTED[@]})); then
    say "stopping the local stack"
    for ((i = ${#STARTED[@]} - 1; i >= 0; i--)); do kill_tree "${STARTED[$i]}"; done
    wait 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  exit "$code"
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# ---------------------------------------------------------------- env
set -a
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a
for v in RUNNER_PK SELLER_PK SELLER_ADDR BUYER_ADDR JUROR1_PK JUROR2_PK JUROR3_PK JUROR1_ADDR JUROR2_ADDR JUROR3_ADDR; do
  [ -n "${!v:-}" ] || die "$v missing from $ROOT/.env"
done
[ -n "${FIREWORKS_API_KEY:-}" ] || [ -n "${SKIP_PREVIEW:-}" ] || die "FIREWORKS_API_KEY missing (needed for the preview); SKIP_PREVIEW=1 lists without it"

RPC="http://127.0.0.1:$ANVIL_PORT"
TEE="http://127.0.0.1:$TEE_PORT"
export CHAIN_ID=31337 RPC_URL="$RPC" ANVIL_RPC="$RPC" TEE_URL="$TEE" PUBLIC_URL="$TEE" TEE_PUBLIC_URL="$TEE"
unset MARKET_ADDRESS TOKEN_ADDRESS TOKEN_ADDR MNEMONIC START_BLOCK || true

mkdir -p "$STACK_DIR" "$LOGS"
trap cleanup EXIT INT TERM
stop_previous
PORTS=("$ANVIL_PORT" "$TEE_PORT")
[ "${WEB:-1}" = 0 ] || PORTS+=("$WEB_PORT")
for p in "${PORTS[@]}"; do
  port_busy "$p" && die "port $p is held by a process this script did not start (pick another via ANVIL_PORT / TEE_PORT / WEB_PORT)"
done
rm -rf "$STACK_DIR/tee-data" "$STACK_DIR/agents-data" "$STACK_DIR/juror-data" "$STACK_DIR/deployments" "$STACK_DIR/report.json"
: >"$PIDFILE"

for d in agents services/tee services/jurors apps/web; do
  [ -d "$ROOT/$d/node_modules" ] || { say "npm install in $d"; (cd "$ROOT/$d" && npm install --no-audit --no-fund >/dev/null); }
done

# ---------------------------------------------------------------- chain + contracts
say "anvil on :$ANVIL_PORT (1 s blocks)"
start_bg anvil "$LOGS/anvil.log" anvil --port "$ANVIL_PORT" --block-time 1
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = 31337 ] || die "anvil did not start (see $LOGS/anvil.log)"

say "deploy contracts (contracts/scripts/deploy.sh anvil)"
mkdir -p "$ROOT/deployments" "$STACK_DIR/deployments"
if [ -f "$SHARED_DEP" ]; then DEP_BACKUP="$STACK_DIR/shared-31337.backup.json"; cp "$SHARED_DEP" "$DEP_BACKUP"; fi
DEP_TOUCHED=1
(cd "$ROOT" && RPC="$RPC" contracts/scripts/deploy.sh anvil) >"$LOGS/deploy.log" 2>&1 || { tail -30 "$LOGS/deploy.log"; die "deploy failed"; }
cp "$SHARED_DEP" "$STACK_DIR/deployments/31337.json"
restore_deployment
export DEPLOYMENTS_DIR="$STACK_DIR/deployments"
dep() { node -p "require('$STACK_DIR/deployments/31337.json').$1"; }
MARKET="$(dep market)"
START_BLOCK="$(dep startBlock)"
export MARKET_ADDRESS="$MARKET"
echo "    market $MARKET (token $(dep token), start block $START_BLOCK)"

# local dev: the TEE signs every role with RUNNER_PK
TEE_SIGNER="$(cast wallet address --private-key "$RUNNER_PK")"
OWNER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
for fn in setRunner setRelay setVerifier; do
  cast send --rpc-url "$RPC" --private-key "$OWNER_PK" "$MARKET" "$fn(address,bool)" "$TEE_SIGNER" true >/dev/null
done
for a in "$TEE_SIGNER" "$SELLER_ADDR" "$BUYER_ADDR" "${BUYER2_ADDR:-}" "$JUROR1_ADDR" "$JUROR2_ADDR" "$JUROR3_ADDR"; do
  [ -z "$a" ] || cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
done
echo "    TEE signer $TEE_SIGNER is runner + relay + verifier; actors have gas ETH (Deploy minted their tUSDC)"

say "sync ABIs into apps/web (scripts/sync-web.sh)"
"$ROOT/scripts/sync-web.sh" >"$LOGS/sync-web.log" 2>&1 || { cat "$LOGS/sync-web.log"; die "sync-web failed"; }

# ---------------------------------------------------------------- TEE service
say "TEE service in local-dev mode on :$TEE_PORT (reports say attestation none-local-dev)"
start_bg tee "$LOGS/tee.log" env -C "$ROOT/services/tee" DATA_DIR="$STACK_DIR/tee-data" PORT="$TEE_PORT" TEE_MODE=local-dev node --import tsx src/main.ts
for _ in $(seq 1 90); do curl -sf "$TEE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$TEE/health" >/dev/null || { tail -40 "$LOGS/tee.log"; die "TEE service did not come up (see $LOGS/tee.log)"; }

# ---------------------------------------------------------------- seller agent: listing + preview
export AGENTS_DATA_DIR="$STACK_DIR/agents-data"
seller() { (cd "$ROOT/agents" && node --import tsx src/seller/cli.ts "$@") 2>&1 | tee -a "$LOGS/seller.log"; }
say "seller agent: package → upload to the TEE → list → deposit collateral"
seller package --price "$PRICE" --collateral "$COLLATERAL" >/dev/null
seller upload >/dev/null
VERSION_ID="$(seller list | sed -n 's/^versionId=//p' | tail -1)"
[ -n "$VERSION_ID" ] || die "listing failed (see $LOGS/seller.log)"
seller deposit-collateral --amount "$((COLLATERAL * 3))" >/dev/null
echo "    listed version $VERSION_ID; seller collateral for 3 concurrent sales"

if [ -z "${SKIP_PREVIEW:-}" ]; then
  # The seller pays the preview's inference on-chain before the TEE runs it (attachReport reverts
  # PreviewNotPaid otherwise): TEE quote → exact approve → requestPreview(versionId, fee, quoteHash).
  if [ "$(cast call "$MARKET" 'previewInfo(uint256)(uint256,uint256,bytes32,bool,bool)' "$VERSION_ID" --rpc-url "$RPC" 2>/dev/null | sed -n 2p | awk '{print $1}')" = 0 ]; then
    say "seller pays the preview fee: TEE quote → approve → requestPreview"
    QUOTE_JSON="$(curl -sf "$TEE/preview/quote/$VERSION_ID" || true)"
    if [ -n "$QUOTE_JSON" ]; then
      FEE="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).quote.feeUsdc))' "$QUOTE_JSON")"
      QHASH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).quoteHash)' "$QUOTE_JSON")"
    else # a TEE build without quotes: the on-chain minimum, no quote binding
      FEE="$(cast call "$MARKET" 'minPreviewFee()(uint256)' --rpc-url "$RPC" | awk '{print $1}')"
      QHASH="0x0000000000000000000000000000000000000000000000000000000000000000"
    fi
    cast send --rpc-url "$RPC" --private-key "$SELLER_PK" "$(dep token)" 'approve(address,uint256)' "$MARKET" "$FEE" >/dev/null
    cast send --rpc-url "$RPC" --private-key "$SELLER_PK" "$MARKET" 'requestPreview(uint256,uint256,bytes32)' "$VERSION_ID" "$FEE" "$QHASH" >/dev/null
    echo "    paid $FEE base units (quote $QHASH)"
  fi
  say "preview of version $VERSION_ID: reference panel + validator on Fireworks (takes minutes)"
  curl -s -o /dev/null -X POST "$TEE/preview/$VERSION_ID?async=1" || true
  t0=$(date +%s)
  while :; do
    code="$(curl -s -o "$STACK_DIR/report.json" -w '%{http_code}' "$TEE/reports/$VERSION_ID" || true)"
    [ "$code" = 200 ] && break
    [ "$code" = 202 ] || [ "$code" = 404 ] || { cat "$STACK_DIR/report.json"; echo; die "preview failed (HTTP $code; see $LOGS/tee.log)"; }
    printf '\r    running… %ss ' "$(($(date +%s) - t0))"
    sleep 10
  done
  echo
  # verifies the signed report against the chain and attaches it unless the TEE already did
  seller preview --version-id "$VERSION_ID" >/dev/null
  echo "    signed report attached on-chain"
fi

# ---------------------------------------------------------------- jurors
say "jurors: register + stake all three; agents running: ${JURORS:-1,2,3}"
for n in 1 2 3; do
  (cd "$ROOT/services/jurors" && JUROR_DATA_DIR="$STACK_DIR/juror-data" JUROR_INDEX=$n node --import tsx src/juror.ts register --self-approve-local) >>"$LOGS/jurors.log" 2>&1 \
    || { tail -20 "$LOGS/jurors.log"; die "juror $n registration failed"; }
done
start_bg jurors "$LOGS/jurors.log" env -C "$ROOT/services/jurors" JUROR_DATA_DIR="$STACK_DIR/juror-data" JURORS="${JURORS:-1,2,3}" node --import tsx src/run-all.ts

# ---------------------------------------------------------------- web
cat >"$STACK_DIR/web.env" <<EOF
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=$RPC
NEXT_PUBLIC_TEE_URL=$TEE
NEXT_PUBLIC_MARKET_ADDRESS=$MARKET
NEXT_PUBLIC_START_BLOCK=$START_BLOCK
EOF
if [ "${WEB:-1}" != 0 ]; then
  say "web app (next dev) on :$WEB_PORT"
  # shellcheck disable=SC2046
  start_bg web "$LOGS/web.log" env -C "$ROOT/apps/web" $(cat "$STACK_DIR/web.env") node node_modules/next/dist/bin/next dev -p "$WEB_PORT"
  for _ in $(seq 1 90); do curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT/" && break; sleep 1; done
fi

say "local stack is up; Ctrl-C stops everything this script started"
cat <<EOF
  chain   $RPC (chainId 31337), market $MARKET
  TEE     $TEE/health (listing: version $VERSION_ID)
  web     $([ "${WEB:-1}" != 0 ] && echo "http://localhost:$WEB_PORT" || echo "not started; env in $STACK_DIR/web.env")
  logs    $LOGS/{anvil,deploy,tee,seller,jurors,web}.log

  Burner wallets in the web app (wallet menu → "Use a burner key"): paste the private key held in
  these repo .env variables. Throwaway local keys only.
    seller    SELLER_PK
    buyers    BUYER_PK, BUYER2_PK
    jurors    JUROR1_PK, JUROR2_PK, JUROR3_PK   (agents running for: ${JURORS:-1,2,3})
    observer  DEPLOYER_PK, or any funded key

  Time travel (anvil only), e.g. past the 300 s challenge window:
    cast rpc evm_increaseTime 301 --rpc-url $RPC && cast rpc evm_mine --rpc-url $RPC
EOF

wait
