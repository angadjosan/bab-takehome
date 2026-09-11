#!/usr/bin/env bash
# Verify every task (purchased + audit): hidden tests FAIL on the starting
# state and PASS after the reference solution is applied through the
# environment's own write_file actions.
#
#   scripts/verify.sh            # native (needs Python 3.12 + pytest 8.3.5; set PYTHON=...)
#   scripts/verify.sh --docker   # build Dockerfile.runner, run offline + read-only + resource-limited
#   scripts/verify.sh --all      # both
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---native}"
IMAGE="${PYREPAIR_IMAGE:-py-repair-kit-runner:local}"

native() {
  cd "$KIT"
  local py="${PYTHON:-python3}"
  "$py" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 required, got " + sys.version'
  "$py" -c 'import pytest; assert pytest.__version__ == "8.3.5", "pytest 8.3.5 required, got " + pytest.__version__'
  echo "== native: $("$py" -c 'import sys; print(sys.executable, sys.version.split()[0])')"
  "$py" scripts/verify_tasks.py
}

in_docker() {
  echo "== docker: building $IMAGE from Dockerfile.runner"
  docker build -q -f "$KIT/Dockerfile.runner" -t "$IMAGE" "$KIT" >/dev/null
  echo "== docker: image $(docker image inspect --format '{{.Id}}' "$IMAGE")"
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --cpus 1 --memory 512m --pids-limit 128 \
    --security-opt no-new-privileges --cap-drop ALL \
    -e PYTHON=python \
    -v "$KIT:/env:ro" -w /env \
    "$IMAGE" bash scripts/verify.sh --native
}

case "$MODE" in
  --native) native ;;
  --docker) in_docker ;;
  --all) native && in_docker ;;
  *) echo "usage: $0 [--native|--docker|--all]" >&2; exit 64 ;;
esac
