#!/usr/bin/env bash
# Build the runner image and record its identity in IMAGE_DIGEST (part of the canonical archive).
# Optionally save the image archive: scripts/build-image.sh --save out/runner-image.tar
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PYREPAIR_IMAGE:-humanevalfix-8-runner:local}"
docker build -q -f "$KIT/Dockerfile.runner" -t "$IMAGE" "$KIT" >/dev/null
ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
BASE="$(sed -n 's/^FROM //p' "$KIT/Dockerfile.runner")"
printf '%s\n' "image=$ID" "base=$BASE" "dockerfile_sha256=$(shasum -a 256 "$KIT/Dockerfile.runner" | cut -d' ' -f1)" > "$KIT/IMAGE_DIGEST"
cat "$KIT/IMAGE_DIGEST"
if [ "${1:-}" = "--save" ]; then
  docker save -o "${2:?archive path}" "$IMAGE"
  echo "archive_sha256=$(shasum -a 256 "$2" | cut -d' ' -f1)"
fi
