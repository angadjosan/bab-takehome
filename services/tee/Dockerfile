# EnvMarket TEE service image for EigenCompute (linux/amd64, runs as root as EigenCompute requires).
#
# Build from the REPO ROOT (the service depends on packages/shared):
#   docker buildx build --platform linux/amd64 -f services/tee/Dockerfile -t <registry>/envmarket-tee:<tag> --push .
# The per-Dockerfile ignore file services/tee/Dockerfile.dockerignore limits the context to
# packages/shared + services/tee. No seller bundle is baked in: bundles arrive encrypted via
# POST /seller/upload and are decrypted only inside the running TEE.
#
# Runtime: CPython 3.12 from the SAME pinned base the seller's runner image uses
# (python:3.12-slim@sha256:78387bc3…), Node 22 copied from a pinned official image, util-linux
# (unshare / setpriv / prlimit) for the in-TEE sandbox, pytest pinned by hash for the grader.
# Secrets (MNEMONIC from the KMS, FIREWORKS_API_KEY, BASE_RPC, …) are NEVER set here: ENV values
# are part of the attested measurement and visible in the attestation token.

# Both bases are multi-arch indexes pinned by digest; the platform comes from
# `docker buildx build --platform linux/amd64` (EigenCompute) or linux/arm64 (native local smoke tests).
FROM node:22.22.2-trixie-slim@sha256:55931e785da6feb47a9ed9ee54093b7710f3cbab9962708e5c4c9b5318c66451 AS node

FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && node --version && python3 --version \
 && command -v unshare setpriv prlimit

# grader runtime (the service also builds a per-bundle venv from each bundle's requirements.lock)
COPY services/tee/runtime/requirements.lock /tmp/requirements.lock
RUN python3 -m pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: -r /tmp/requirements.lock \
 && rm /tmp/requirements.lock

# Reference harness (harness/envmarket_coding, Prime Intellect verifiers 0.3.1): source + its
# hash-pinned lock, installed into its own venv. The whole directory (minus .venv) is copied so the
# harness's self-computed harnessDigest matches a local checkout of the same commit.
COPY harness/envmarket_coding /app/harness/envmarket_coding
RUN python3 -m venv /opt/harness-venv \
 && /opt/harness-venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes -r /app/harness/envmarket_coding/requirements.lock \
 && cd /app/harness/envmarket_coding && /opt/harness-venv/bin/python -m envmarket_coding.run --digest > /dev/null

WORKDIR /app
COPY packages/shared/package.json packages/shared/package-lock.json packages/shared/
RUN cd packages/shared && npm ci --omit=dev --no-audit --no-fund
COPY services/tee/package.json services/tee/package-lock.json services/tee/
RUN cd services/tee && npm ci --omit=dev --no-audit --no-fund
COPY packages/shared/src packages/shared/src
COPY services/tee/tsconfig.json services/tee/
COPY services/tee/src services/tee/src
COPY services/tee/runtime services/tee/runtime

# Non-secret defaults only.
ENV NODE_ENV=production \
    HARNESS_DIR=/app/harness/envmarket_coding \
    HARNESS_PYTHON=/opt/harness-venv/bin/python \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    SANDBOX=auto \
    PYTHONDONTWRITEBYTECODE=1
RUN mkdir -p /data && chmod 711 /data

WORKDIR /app/services/tee
EXPOSE 8080
USER root
CMD ["node", "--import", "tsx", "src/main.ts"]
