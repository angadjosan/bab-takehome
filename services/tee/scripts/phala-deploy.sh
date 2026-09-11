#!/usr/bin/env bash
# Build -> push -> deploy|update the EnvMarket TEE service on Phala Cloud (dstack CVM, Intel TDX).
#
# Usage:
#   services/tee/scripts/phala-deploy.sh build                        # build + push + pin the digest in the compose
#   services/tee/scripts/phala-deploy.sh deploy <env-file>            # first deploy: new app id => new signer
#   services/tee/scripts/phala-deploy.sh update <env-file> [cvm-id]   # new image/env, SAME app id => same signer
#
# Env overrides: IMAGE_REPO (default docker.io/angadsinghjosan/envmarket-tee), REF (git ref to build, default HEAD),
#   APP_NAME (default envmarket-tee), INSTANCE_TYPE (default tdx.large = 4 vCPU / 8 GB), PHALA_CLI (default phala@1.1.22),
#   OS_IMAGE (default dstack-0.5.9, the non-dev dstack OS),
#   SKIP_BUILD=1 (reuse the digest already pinned in the compose), OUT_DIR (where CLI JSON output is saved).
#
# <env-file> is the SEALED env (dotenv), encrypted client-side by the CLI and decrypted only inside the CVM.
# Keep it outside git (repo .gitignore covers .env.*). Keys the compose reads:
#   FIREWORKS_API_KEY, CHAIN_ID=84532, BASE_SEPOLIA_RPC, MARKET_ADDRESS, START_BLOCK (deployments/84532.json),
#   PUBLIC_URL (https://<app_id>-8080.<gateway domain>, known after the first deploy; then `update`).
# This script never prints the env file's values, only its key names.
#
# Auth: PHALA_CLOUD_API_KEY from the environment, else from the repo-root .env (read, never echoed).
# The image is built from a clean `git archive` of REF, never from the (possibly dirty) working tree, and
# pushed for linux/amd64. The repo must be PUBLIC (or add DSTACK_DOCKER_* registry creds to the sealed env).
# KMS: --kms phala (default; no wallet). App keys are derived per app id, so `update` keeps the signer.
set -euo pipefail

CMD=${1:?usage: phala-deploy.sh build|deploy|update [env-file] [cvm-id]}
ENV_FILE=${2:-}
IMAGE_REPO=${IMAGE_REPO:-docker.io/angadsinghjosan/envmarket-tee}
REF=${REF:-HEAD}
APP_NAME=${APP_NAME:-envmarket-tee}
INSTANCE_TYPE=${INSTANCE_TYPE:-tdx.large}
PHALA_CLI=${PHALA_CLI:-phala@1.1.22}
# Production (non-dev) dstack OS. Left unset, the CLI auto-selected dstack-dev-0.5.9 (DEV=yes) on 2026-09-11.
# `phala os-images` lists them; never deploy a DEV image for the demo.
OS_IMAGE=${OS_IMAGE:-dstack-0.5.9}
REPO_ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
COMPOSE="$REPO_ROOT/services/tee/phala/docker-compose.yml"
SHA=$(git -C "$REPO_ROOT" rev-parse --short=7 "$REF")
IMAGE="$IMAGE_REPO:$SHA"
OUT_DIR=${OUT_DIR:-$(mktemp -d)}
mkdir -p "$OUT_DIR"

if [[ -z "${PHALA_CLOUD_API_KEY:-}" && -f "$REPO_ROOT/.env" ]]; then
  PHALA_CLOUD_API_KEY=$(grep -E '^PHALA_CLOUD_API_KEY=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'" || true)
  export PHALA_CLOUD_API_KEY
fi
# Run the CLI from an empty dir so it never picks up a stray phala.toml / docker-compose.yml / .env.
RUN_DIR=$(mktemp -d)
phala() { (cd "$RUN_DIR" && npx -y "$PHALA_CLI" "$@"); }

build() {
  local work
  work=$(mktemp -d)
  git -C "$REPO_ROOT" archive "$REF" | tar -x -C "$work"
  # build context = repo root; services/tee/Dockerfile.dockerignore limits it to shared + tee + harness
  docker buildx build --platform linux/amd64 -f "$work/services/tee/Dockerfile" -t "$IMAGE" --push "$work"
  rm -rf "$work"
}

pin_digest() {
  local digest
  digest=$(docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest.Digest}}' | tr -d '"')
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "could not resolve digest for $IMAGE" >&2; exit 1; }
  # pin by digest: compose_hash then commits to the exact image
  sed -i.bak -E "s#^([[:space:]]*image:[[:space:]]*).*envmarket-tee.*#\1${IMAGE_REPO}@${digest}#" "$COMPOSE" && rm -f "$COMPOSE.bak"
  echo "image: $IMAGE -> $IMAGE_REPO@$digest (pinned in services/tee/phala/docker-compose.yml; commit it)"
}

check_env_file() {
  [[ -f "$ENV_FILE" ]] || { echo "env file required: $ENV_FILE" >&2; exit 1; }
  ENV_FILE=$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")
  echo "sealed env keys: $(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ')"
  for k in FIREWORKS_API_KEY CHAIN_ID BASE_SEPOLIA_RPC MARKET_ADDRESS START_BLOCK; do
    grep -qE "^$k=." "$ENV_FILE" || { echo "sealed env is missing $k" >&2; exit 1; }
  done
}

if [[ "$CMD" != build ]]; then
  check_env_file
  [[ -n "${PHALA_CLOUD_API_KEY:-}" ]] || { echo "PHALA_CLOUD_API_KEY not set (env or repo .env)" >&2; exit 1; }
fi
if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  build
  pin_digest
fi
grep -qE 'image:.*@sha256:0{64}' "$COMPOSE" && { echo "compose image is still the placeholder digest; run without SKIP_BUILD" >&2; exit 1; }

case "$CMD" in
  build) exit 0 ;;
  deploy)
    phala deploy -n "$APP_NAME" -c "$COMPOSE" -e "$ENV_FILE" -t "$INSTANCE_TYPE" --kms phala --image "$OS_IMAGE" \
      --no-public-logs --public-tcbinfo --wait --json | tee "$OUT_DIR/phala-deploy.json"
    ;;
  update)
    phala deploy --cvm-id "${3:-$APP_NAME}" -c "$COMPOSE" -e "$ENV_FILE" --image "$OS_IMAGE" \
      --no-public-logs --public-tcbinfo --wait --json | tee "$OUT_DIR/phala-update.json"
    ;;
  *) echo "unknown command $CMD" >&2; exit 1 ;;
esac

phala cvms get "${3:-$APP_NAME}" --json > "$OUT_DIR/phala-cvm.json" || true
echo "CLI output saved in $OUT_DIR"
# Then check:  curl https://<app_id>-8080.<gateway>/health               (keySource dstack-kms, attestation.kind phala-dstack-tdx)
#              curl 'https://<app_id>-8080.<gateway>/attestation?refresh=1' (quote; verify at https://trust.phala.com/app/<app_id>)
# Logs:        npx -y $PHALA_CLI logs --cvm-id <name>   (logs are private: --no-public-logs)
