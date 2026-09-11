#!/usr/bin/env bash
# Deploy EnvMarket (+ views module, + TestUSDC on anvil) and record deployments/<chainId>.json.
#
#   contracts/scripts/deploy.sh            # local anvil at $RPC or http://127.0.0.1:8545
#   contracts/scripts/deploy.sh base       # Base mainnet via $BASE_RPC (needs TOKEN_ADDR + CONFIRM_MAINNET=yes)
#   RPC=http://host:8545 contracts/scripts/deploy.sh
#
# Reads repo-root .env (DEPLOYER_PK, TOKEN_ADDR, RUNNER_ADDR, RELAY_ADDR, VERIFIER_ADDR,
# JUROR{1,2,3}_ADDR, PARAM_SET, ...). Secrets are passed to forge via the environment only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(dirname "$HERE")"
ROOT="$(dirname "$CONTRACTS")"
export PATH="$HOME/.foundry/bin:$PATH"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

TARGET="${1:-anvil}"
case "$TARGET" in
  anvil) RPC="${RPC:-http://127.0.0.1:8545}" ;;
  base) RPC="${RPC:-${BASE_RPC:-https://mainnet.base.org}}" ;;
  base-sepolia) RPC="${RPC:-${BASE_SEPOLIA_RPC:-https://sepolia.base.org}}" ;;
  *) echo "usage: $0 [anvil|base|base-sepolia]" >&2; exit 1 ;;
esac

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
echo "==> target=$TARGET rpc=$RPC chainId=$CHAIN_ID"

EXTRA=()
if [ "$CHAIN_ID" = "31337" ]; then
  # Local anvil: fall back to anvil's well-known account #0 if no deployer key is configured,
  # and top up the deployer with test ETH so any configured key works.
  export DEPLOYER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
  DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PK")"
  cast rpc anvil_setBalance "$DEPLOYER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
  # TOKEN_ADDR only applies if a contract exists there (e.g. an anvil fork of Base with real USDC).
  if [ -n "${TOKEN_ADDR:-}" ] && [ "$(cast code "$TOKEN_ADDR" --rpc-url "$RPC")" = "0x" ]; then
    echo "==> TOKEN_ADDR has no code on this anvil; deploying TestUSDC instead"
    export TOKEN_ADDR=""
  fi
else
  : "${DEPLOYER_PK:?DEPLOYER_PK is required}"
  if [ "$CHAIN_ID" != "84532" ] || [ -n "${TOKEN_ADDR:-}" ]; then
    # Base Sepolia deploys TestUSDC when TOKEN_ADDR is empty; every other chain needs a real token.
    : "${TOKEN_ADDR:?TOKEN_ADDR is required off-anvil (Base mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)}"
    SYMBOL="$(cast call "$TOKEN_ADDR" 'symbol()(string)' --rpc-url "$RPC")"
    DECIMALS="$(cast call "$TOKEN_ADDR" 'decimals()(uint8)' --rpc-url "$RPC")"
    echo "==> token $TOKEN_ADDR symbol=$SYMBOL decimals=$DECIMALS"
    [ "$DECIMALS" = "6" ] || { echo "token must have 6 decimals" >&2; exit 1; }
  fi
  if [ "$CHAIN_ID" = "8453" ] && [ "${CONFIRM_MAINNET:-}" != "yes" ]; then
    echo "Refusing to deploy to Base MAINNET without CONFIRM_MAINNET=yes" >&2
    exit 1
  fi
  EXTRA+=(--slow)
  if [ -n "${BASESCAN_API_KEY:-}" ]; then
    EXTRA+=(--verify --etherscan-api-key "$BASESCAN_API_KEY")
  fi
fi

cd "$CONTRACTS"
# ${EXTRA[@]+...} keeps `set -u` happy with an empty array on macOS bash 3.2
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast ${EXTRA[@]+"${EXTRA[@]}"}

node "$HERE/write-deployment.mjs" \
  "$CONTRACTS/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json" \
  "$RPC" \
  "$ROOT/deployments/$CHAIN_ID.json"
