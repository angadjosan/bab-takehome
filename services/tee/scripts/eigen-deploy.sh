#!/usr/bin/env bash
# Build -> push -> deploy|upgrade the EnvMarket TEE service on EigenCompute (EigenCloud, Intel TDX).
#
# Usage:
#   services/tee/scripts/eigen-deploy.sh deploy  <env-file>            # first deploy (new app id => new signer)
#   services/tee/scripts/eigen-deploy.sh upgrade <env-file> [app-id]   # new image/env, SAME app id + signer
#   services/tee/scripts/eigen-deploy.sh info                          # app id, status, IP, KMS-derived EVM address
#
# Env overrides: ECLOUD_ENV (default sepolia), IMAGE_REPO (default docker.io/angadsinghjosan/envmarket-tee),
#   REF (git ref to build, default HEAD), APP_NAME (default envmarket-tee), INSTANCE_TYPE (default g1-standard-4t = TDX),
#   SKIP_BUILD=1 (reuse an already-pushed $IMAGE_REPO:<sha>).
#
# <env-file> is the SEALED app env (dotenv). Everything not suffixed _PUBLIC is encrypted to the KMS key
# and only decrypted inside the TEE. Never put secrets in the Dockerfile (ENV is in the attested measurement).
# MNEMONIC is injected by the KMS; never set it. Keep the file outside git (repo .gitignore covers .env.*).
# Minimal contents for the Base Sepolia demo:
#   FIREWORKS_API_KEY=...
#   CHAIN_ID=84532
#   BASE_SEPOLIA_RPC=https://sepolia.base.org
#   RPC_URL=https://sepolia.base.org
#   MARKET_ADDRESS=<deployments/84532.json market>
#   TOKEN_ADDRESS=<deployments/84532.json token>
#   START_BLOCK=<deployments/84532.json startBlock>
#   EIGEN_ENVIRONMENT_PUBLIC=sepolia
#   # after the first deploy (then `upgrade`):
#   PUBLIC_URL=http://<app ip>:8080
#   EIGEN_APP_ID_PUBLIC=<app id>
# (DEPLOYMENTS_DIR is not usable in the image: deployments/ is not copied, so MARKET_ADDRESS/START_BLOCK are required.)
#
# Prereqs: `npm i -g @layr-labs/ecloud-cli` (v1.0.0), `ecloud auth login`, `ecloud billing subscribe`,
# `docker login` (the repo must be PUBLIC so EigenCompute can pull), Sepolia ETH on the auth key for the
# AppController tx (Ethereum Sepolia; ~0.0x ETH per deploy/upgrade).
#
# Quota gate: `deploy` first checks AppController.getMaxActiveAppsPerUser(<auth key>) on Ethereum Sepolia
# (0x0dd810a6ffba6a9820a10d97b659f07d8d23d4E2). It must be > 0; it is set by an EigenLabs admin/billing
# backend, not by us. `ecloud billing status` can say "Active, $20 credits" while the on-chain quota is
# still 0 -> "no app quota available" (seen 2026-09-11; fix: eigencloud_support@eigenlabs.org). Check with:
#   cast call 0x0dd810a6ffba6a9820a10d97b659f07d8d23d4E2 'getMaxActiveAppsPerUser(address)(uint32)' <addr> \
#     --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# The app id printed before the quota check comes from a random salt; nothing is reserved until the tx lands.
#
# The image is built from a clean `git archive` of REF, never from the (possibly dirty) working tree.
set -euo pipefail

CMD=${1:?usage: eigen-deploy.sh deploy|upgrade|info [env-file] [app-id]}
ENV_FILE=${2:-}
ECLOUD_ENV=${ECLOUD_ENV:-sepolia}
IMAGE_REPO=${IMAGE_REPO:-docker.io/angadsinghjosan/envmarket-tee}
REF=${REF:-HEAD}
APP_NAME=${APP_NAME:-envmarket-tee}
INSTANCE_TYPE=${INSTANCE_TYPE:-g1-standard-4t}
REPO_ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
SHA=$(git -C "$REPO_ROOT" rev-parse --short=7 "$REF")
IMAGE="$IMAGE_REPO:$SHA"

if [[ "$CMD" == info ]]; then
  ecloud compute app info "${3:-$APP_NAME}" --environment "$ECLOUD_ENV" --address-count 1
  exit 0
fi
[[ -f "$ENV_FILE" ]] || { echo "env file required: $ENV_FILE" >&2; exit 1; }
ENV_FILE=$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  git -C "$REPO_ROOT" archive "$REF" | tar -x -C "$WORK"
  # linux/amd64 only (EigenCompute); build context = repo root, Dockerfile.dockerignore limits it.
  docker buildx build --platform linux/amd64 -f "$WORK/services/tee/Dockerfile" -t "$IMAGE" --push "$WORK"
fi
DIGEST=$(docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest.Digest}}' | tr -d '"')
echo "image: $IMAGE@$DIGEST"

# Run ecloud from an empty dir so it cannot pick up a stray ./Dockerfile or ./.env.
RUN_DIR=$(mktemp -d)
cd "$RUN_DIR"
COMMON=(--environment "$ECLOUD_ENV" --non-interactive --force --verbose
        --image-ref "$IMAGE" --env-file "$ENV_FILE" --instance-type "$INSTANCE_TYPE"
        --log-visibility public --resource-usage-monitoring enable --watch-timeout 900)

case "$CMD" in
  deploy)
    ecloud compute app deploy "${COMMON[@]}" --name "$APP_NAME" --skip-profile
    ;;
  upgrade)
    ecloud compute app upgrade "${3:-$APP_NAME}" "${COMMON[@]}"
    ;;
  *) echo "unknown command $CMD" >&2; exit 1 ;;
esac

ecloud compute app info "${3:-$APP_NAME}" --environment "$ECLOUD_ENV" --address-count 1
# Then check: curl http://<ip>:8080/health  (signer == "EVM Address" above)
#             curl 'http://<ip>:8080/attestation?refresh=1'  (kind == eigencompute-tdx, token present)
# Logs:       ecloud compute app logs <app-id> --environment "$ECLOUD_ENV" [--watch]
