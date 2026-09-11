# services/tee — EnvMarket trusted service (EigenCompute TEE)

One Node 22 service, deployed as an EigenCompute app (Intel TDX, GCP Confidential Space). It
holds the only copies of sellers' bundle/audit keys, runs previews and mechanical disputes
against the plaintext environment offline, relays bundle keys to buyers, and serves
evidence to seated jurors. Its signer (from the KMS mnemonic) is registered in `EnvMarket` as
runner, relay and verifier. Contracts only check its EIP-712 signatures.

**Trust, stated plainly.** Inside EigenCompute, the operator can't read the plaintext.
The attestation JWT binds the signer and X25519 key to the attested image. The developer can
still upgrade the image, and one EigenLabs KMS operator is trusted. The reference panel and the
validator run on **Fireworks**, so Fireworks sees task statements and workspace files during
episodes, and sees environment files when the validator runs. The TEE protects keys, hidden
tests, grading and signing. It does not protect model inference. Local dev mode
(`attestation.kind = "none-local-dev"`) is for tests only; there, the host sees everything.

## Components

| Module | What it does |
|---|---|
| `keys.ts` | `MNEMONIC` (KMS) → secp256k1 signer at `m/44'/60'/0'/0/0`. X25519 sk = HKDF-SHA256(BIP39 seed, info `envmarket.tee.x25519.v1`). Storage key = HKDF(seed, `envmarket.tee.storage.v1`). Local dev uses `RUNNER_PK` as the ikm. |
| `store.ts` | Public blob store (`DATA_DIR/blobs/<sha256>`) and private records (AES-256-GCM with the storage key, `ns/id` bound as AAD, root-only dir). |
| `bundle.ts` | `POST /seller/upload`: unwrap keys, decrypt, check the canonical tar, bundleHash, manifest (bundleDigest, grader digest, image ref, counts), task and audit Merkle roots with the salts, and the public docs. Then a preflight in the sandbox: install `requirements.lock`, import the grader, collect hidden tests, apply reference solutions. |
| `harness.ts` | The real LLM agent harness: one pass@1 episode per (model, task). |
| `validator.ts` | Fixed versioned prompt, bounded JSON schema, 120-word / 1000-byte render, output screening. |
| `preview.ts` | `POST /preview/:versionId`: on-chain terms must match the upload. Runs the panel and the validator, builds `report.json`, signs `PreviewReport`, submits `attachReport`. |
| `relay.ts` | On `Purchased`: build the wrapper, wrap `K_bundle` to `buyerEncPubKey` (EMKW1, salt = wrapperHash), persist, sign `DeliveryReceipt`, then submit `recordDelivery`. |
| `verifier.ts` | On `DisputeOpened` (ground 1 or 3): recheck, rebuild and rerun, publish findings JSON, sign `MechanicalFinding`, submit `resolveMechanical`. |
| `evidence.ts` | Evidence upload for buyers and case packets for seated jurors (EIP-191 challenge). |
| `watcher.ts` | Polls `getLogs` from `START_BLOCK` with a persisted cursor. Handlers are idempotent and read on-chain state first. |
| `attestation.ts` | Port of `@layr-labs/ecloud-sdk@1.0.0` `AttestClient`: launcher socket, then KMS `/auth/attest`, then a KMS-signed JWT with `extra_data = sha512(binding)`. |
| `sandbox.ts` + `runtime/` | Isolation for seller code (see below). `runtime/netdeny.py` is the seccomp launcher; `runtime/check_tasks.py` is the in-sandbox task checker. |

## HTTP API

| Method & path | Description |
|---|---|
| `GET /health` | `{signer, encPubKey, keySource, chainId, market, attestation{kind, appId, imageDigest, verifyUrl, quoteDigest}, sandbox, inference, watcher, uploadKeyWrap}` |
| `GET /attestation[?refresh=1]` | The full attestation state: `kind`, `binding` (canonical JSON the JWT commits to), `token` (KMS JWT, in the TEE only), `tokenClaims`, `quoteDigest = sha256(token)`, `kmsPublicKey`, `verifyUrl`, and the signer's on-chain roles. |
| `GET /protocol` | The precommitted preview protocol: harness spec, agent prompt, tools, `promptDigest`, validator prompt, schema, `promptHash`, screening rules, and reproducibility tolerances. |
| `PUT /blobs` (raw bytes) | Returns `{sha256, bytes, url}`. |
| `GET /blobs/<64hex>` | A content-addressed public doc or ciphertext. |
| `POST /seller/upload` | See below. Returns `{uploadId, stored{…digests, ciphertextUrl, blobBaseUrl}, checks[], preflight}`; HTTP 400 with `checks[]` on any mismatch. |
| `POST /preview/:versionId[?async=1]` | Returns `{cached, report, reportJson, reportHash, signature, signer, attachTx, attestationToken, disclosures}`. With `async=1` it returns 202 and you poll `GET /reports/:versionId`. Rate limits (fresh runs only): `PREVIEW_RATE_PER_LISTING_PER_HOUR`, `PREVIEW_RATE_GLOBAL_PER_HOUR`. |
| `GET /reports/:versionId` | The signed report. Returns 202 `{status:"running"}` while running and 500 `{status:"failed"}` on failure. |
| `POST /preview/:versionId/attach` | Submits `attachReport` for a stored report (for `SUBMIT_TXS=0` runs or a failed attach). |
| `GET /deliveries/:purchaseId` | `{wrapper (canonical JSON), wrapperHash, wrappedKey (base64 EMKW1), wrappedKeyHash, ciphertextUrl, bundleHash, relay, deliveredTx}`. Served only when the purchase is Delivered on-chain with the same `wrapperHash` and `wrappedKeyHash`. |
| `POST /evidence-upload` | Body `{content}` \| `{base64}` \| any JSON object. Returns `{evidenceHash}`, the sha256 of the stored bytes; pass it to `openDispute`. Stored privately. |
| `POST /evidence/:disputeId` | Body `{juror, message, signature, encPubKey?}`. `message` = shared `evidenceAuthMessage(...)`, EIP-191-signed by the juror. Returns `{packet, packetHash, packetSignature}`, or the packet encrypted to `encPubKey`. |
| `GET /findings/:disputeId` | The public findings JSON; its sha256 is the on-chain `findingsHash`. |

### Upload body (`POST /seller/upload`, JSON, binary fields base64)

```jsonc
{
  "encryptedBundle":  "<EMENC1(K_bundle, canonical tar)>",
  "encryptedAudit":   "<EMENC1(K_audit, canonical tar of audit-tasks/)>",
  "wrappedBundleKey": "<EMKW1 to /health encPubKey; HKDF salt = sha256(encryptedBundle); info 'envmarket.upload.v1'>",
  "wrappedAuditKey":  "<same, same salt>",
  "encryptedSalts":   "<EMENC1(K_audit, salts.json)>",        // or EMENC1(K_salts) plus "wrappedSaltsKey"
  "publicDocs": { "description.json": "<text>", "description.md": "<text>", "manifest.json": "<text>", "license": {"base64": "…"} },
  "claims": { "bundleHash": "0x…", "taskRoot": "0x…", "auditRoot": "0x…", "taskCount": 5, "auditTaskCount": 2,
              "descriptionHash": "0x…", "manifestHash": "0x…", "licenseHash": "0x…", "imageDigest": "0x…", "environmentVersion": "…" }
}
```

`info = 'envmarket.keywrap.v1'` is also accepted, and for the audit key so is salt =
sha256(encryptedAudit). Every claim you send is checked.

## How it works

**Preview.** Resolves the **pinned** Fireworks panel (`glm-5p3`, `kimi-k3`, `qwen3p8-max`)
against the live `/models` list. It never substitutes a different family; a model that isn't
listed is reported as `unavailable`. For every model and every purchased task (T1..T5) and
audit task (A1..A2) it runs one episode (pass@1), with up to `PREVIEW_CONCURRENCY` in parallel.

- **Agent phase.** `python -m grader.env serve` runs offline in the sandbox over a kit holding
  only `src/`, `grader/` and this task's statement, overlay and visible tests. Hidden tests,
  solutions and other tasks are absent. The model gets OpenAI-style function calling
  (`list_files`, `read_file`, `write_file`, `run_visible_tests`, `submit`), temperature 0,
  seed 1337, an action budget of 12 (submit is free), and a wall-clock budget of
  `EPISODE_TIME_SEC`.
- **Grade phase.** A separate sandboxed process with a different uid runs `python -m grader.grade`
  with the hidden tests.
- **Scoring.** Budget exhaustion, timeouts and missing submits count as failures. Infra failures
  are counted as attempted, not solved, and also reported in `infraFailures`. Scores are rounded
  to 5 pp, with purchased and audit reported separately.
- **Validator.** `deepseek-v4-pro` reads the environment under the fixed prompt. Its output is
  screened for ≥8-token copied spans, code, paths, task ids and identifiers, long base64/hex, and
  obedience to embedded instructions. If screening fails, the report says "Explanation withheld by output screening." with the reasons.
- **Report.** Per-task outcomes and transcripts stay in private records. Job statuses mean "graded"
  or "infra_failure", never solved or unsolved, so jobs don't leak per-task outcomes.
  `protocol.harnessDigest` commits to the protocol spec (served at `/protocol`), including the
  reproducibility tolerances.

**Relay.** The watcher sees `Purchased`. The service builds the wrapper (`relay` = its signer),
wraps `K_bundle` to `buyerEncPubKey` with a stored ephemeral key and nonce, and persists the record
*before* signing. It then signs `DeliveryReceipt` and submits `recordDelivery`. After a restart
it reuses the stored record, so the on-chain hashes always match what it serves.

**Mechanical verifier.**
- *BrokenOrHashMismatch.* Rechecks the ciphertext hash, bundle hash and wrapper, and re-derives
  the delivered wrapped key byte for byte. Any mismatch confirms every masked task. Otherwise it
  rebuilds and runs `check_tasks.py` twice. A masked task is confirmed only if both runs show a
  grader import failure, a crash, no collected hidden tests, or hidden tests failing on the
  delivered reference solution.
- *PreviewNotReproducible.* (1) Re-grades every original episode's stored final workspace with a
  tolerance of 0. (2) Re-runs each model once per masked task, with a per-model pass-rate
  tolerance of 5 pp over the masked tasks. At this population size, one changed outcome exceeds
  that tolerance.

The public findings JSON contains aggregates only and no audit data; `findingsHash` is its
sha256. The service signs `MechanicalFinding` and submits `resolveMechanical`.

**Evidence.** A case packet requires all of the following:
- a valid EIP-191 signature;
- chain, market and dispute matching this service;
- expiry within 1 h and a single-use nonce;
- ground = FalseDescription;
- the juror seated on the current round on-chain (`getDispute`).

The packet holds the frozen description (hash-verified), the disputed claims, the buyer's
evidence (hash-verified) and the on-chain delivery record. It also holds mechanical facts the TEE
computed by running the delivered bundle: per-task hidden test counts, whether the starting state
fails, whether the reference solution passes, the file list with sha256s, and source stats. Last
come excerpts: masked `task.json` files and any files the claim or evidence names. It never
includes audit tasks, and every access is logged.

## Sandbox

| Where | How seller code runs |
|---|---|
| EigenCompute (Linux, root) | Each phase gets its own unprivileged uid (`setpriv`) and 0700 dirs, so it can't read other episodes or the service's data or env. It runs under `prlimit` (as/nproc/nofile/fsize/cpu), with a wall-clock kill. Network is denied with `unshare --net --pid` when the kernel allows it, **and/or** `runtime/netdeny.py`, a seccomp-BPF filter that fails every non-AF_UNIX `socket()` and `io_uring_setup` and is inherited by all children. Confidential Space containers usually lack CAP_SYS_ADMIN, so seccomp is the expected path. `detectSandbox` probes both, refuses to run seller code with network, and records what it used in `runtime.sandbox`. |
| macOS / local | `docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /work --cpus 1 --memory 512m --pids-limit 128 --security-opt no-new-privileges --cap-drop ALL --user 65534`, image `python:3.12-slim@sha256:78387bc3…`. |

Dependencies come from the bundle's `requirements.lock`, installed into a cached venv
(`--only-binary=:all:`, plus `--require-hashes` when the lock has hashes). The install uses the
network but runs no seller code; everything after it is offline.

## Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `MNEMONIC` | injected by EigenCompute KMS | The app wallet; the service derives all keys from it. Never set it yourself in the TEE. |
| `FIREWORKS_API_KEY` | sealed `.env` | Inference for the panel and the validator. |
| `CHAIN_ID` | sealed `.env` | `8453` (Base mainnet); `31337` for anvil. |
| `BASE_RPC` / `RPC_URL` | sealed `.env` | RPC endpoint. |
| `MARKET_ADDRESS`, `START_BLOCK` | sealed `.env` | EnvMarket address and the watcher's start block. They can also come from `deployments/<chainId>.json` via `DEPLOYMENTS_DIR`. |
| `PUBLIC_URL` | sealed `.env` | Base URL advertised for blobs (listing `uri`), e.g. `https://<domain>` or `http://<app ip>:8080`. |
| `EIGEN_APP_ID` (or `EIGEN_APP_ID_PUBLIC`), `EIGEN_IMAGE_DIGEST`, `EIGEN_ENVIRONMENT`, `EIGEN_VERIFY_URL` | public `.env` | Shown in reports and `/attestation`. |
| `KMS_SERVER_URL`, `KMS_PUBLIC_KEY` | injected by EigenCompute | Used for the runtime attestation JWT. |
| `PORT` (8080 in the image, 8787 locally), `HOST`, `DATA_DIR` (`/data` in the image, `./.data` locally) | image | HTTP port, bind host and storage directory. |
| `SUBMIT_TXS` (1), `WATCHER` (1), `POLL_MS` | optional | Transaction submission, chain watcher and poll interval. |
| `PREVIEW_CONCURRENCY` (6), `EPISODE_TIME_SEC` (300), `MAX_TOKENS` (8192), `VALIDATOR_MODEL` | optional | Preview and validator tuning. |
| `PREVIEW_RATE_PER_LISTING_PER_HOUR` (3), `PREVIEW_RATE_GLOBAL_PER_HOUR` (12) | optional | Preview rate limits. |
| `SANDBOX` (`auto`/`docker`/`unshare`), `SANDBOX_IMAGE` | optional | Sandbox selection. |
| `LLM_PROVIDER=ollama`, `LOCAL_AGENT_MODEL`, `LOCAL_VALIDATOR_MODEL` | local dev only | Harness check without a Fireworks key. It is labeled in the report and refused when `MNEMONIC` is set. |
| `RUNNER_PK` | local dev only | Signer when no `MNEMONIC` is present. Reports are then labeled `none-local-dev`. |

## Run locally

```bash
cd services/tee && npm install
npm test                 # unit tests (vitest)
npm run typecheck
npm run dev              # local-dev mode on :8787 (RUNNER_PK from repo .env, docker sandbox)
npm run e2e              # full anvil e2e (scripts/local-e2e.ts); E2E_BROKEN_VARIANT=1 adds the upheld-dispute path
```

`npm run e2e` starts anvil on :8555 and deploys with the repo's forge `Deploy` script (the same
steps as `contracts/scripts/deploy.sh`, but it writes to `.data-e2e/deployments/` and leaves the
repo's `deployments/` alone). It packages `seller-workspace/py-repair-kit` with the seller agent's
packager, runs this service in local-dev mode, and walks the flow in this order:
1. upload;
2. listing;
3. real preview on Fireworks;
4. buy, delivery and decrypt;
5. service restart;
6. BrokenOrHashMismatch dispute, resolved;
7. FalseDescription dispute, jurors selected, case packet.

## Deploy to EigenCompute (mainnet-alpha)

The CLI is `ecloud` (`@layr-labs/ecloud-cli@1.0.0`, run with `npx -y @layr-labs/ecloud-cli@1.0.0 …`).
`ecloud --help` and `ecloud compute app deploy --help` were checked. **Nothing was deployed or paid for.**

1. Accounts:
   - `docker login` to a registry EigenCompute can pull from;
   - `ecloud auth login` (or `ecloud auth migrate` from eigenx);
   - `ecloud billing subscribe` (card or USDC);
   - `ecloud compute env set mainnet-alpha`;
   - a little ETH on Ethereum mainnet for the AppController txs.
2. Build and push from the **repo root** (linux/amd64):
   ```bash
   docker buildx build --platform linux/amd64 -f services/tee/Dockerfile -t docker.io/<you>/envmarket-tee:v1 --push .
   ```
3. Write a sealed env file, `services/tee/.env.tee`. It is gitignored by the repo's `.env.*` rule; never commit it.
   ```bash
   FIREWORKS_API_KEY=...
   CHAIN_ID=8453
   BASE_RPC=https://mainnet.base.org
   MARKET_ADDRESS=0x...          # from deployments/8453.json
   START_BLOCK=...
   PUBLIC_URL=http://<ip>:8080   # fill after first deploy, then upgrade
   EIGEN_ENVIRONMENT=mainnet-alpha
   ```
4. Deploy (TDX SKU):
   ```bash
   npx -y @layr-labs/ecloud-cli@1.0.0 compute app deploy --non-interactive --name envmarket-tee \
     --image-ref docker.io/<you>/envmarket-tee:v1 --env-file services/tee/.env.tee \
     --instance-type g1-standard-4t --log-visibility public --environment mainnet-alpha
   npx -y @layr-labs/ecloud-cli@1.0.0 compute app info envmarket-tee --address-count 1   # app id, IP, EVM address
   ```
5. Check the deployment:
   - `curl http://<ip>:8080/health`: `signer` must equal the EVM address from `app info`.
   - `curl http://<ip>:8080/attestation?refresh=1`: must show `kind: "eigencompute-tdx"`, a JWT and `quoteDigest`.
6. As the EnvMarket owner on Base, run `setRunner(signer,true)`, `setRelay(signer,true)` and
   `setVerifier(signer,true)`. Then send the signer a little Base ETH for gas; it submits
   `attachReport`, `recordDelivery` and `resolveMechanical`.
7. Add `EIGEN_APP_ID_PUBLIC=<app id>`, `EIGEN_IMAGE_DIGEST=<digest>` and `PUBLIC_URL` to the env
   file, then run `ecloud compute app upgrade envmarket-tee --image-ref … --env-file …`. The same
   app id keeps the same mnemonic and signer.
8. Optionally, add TLS with `ecloud compute app configure tls` (needs `DOMAIN` and an A record).

**Verifying attestation:**
- The app id and image digest are on the dashboard: `https://verify.eigencloud.xyz/app/<appId>`.
  That URL pattern is an assumption; the dashboard lists app id, releases and digests.
- Read AppController `0xc38d35Fc995e75342A21CBd6D770305b142Fbe67` (mainnet-alpha).
- Check the JWT from `/attestation`: validate its signature against `kmsPublicKey`, check
  `aud = "envmarket-tee"`, and recompute `sha512(binding)` against the token's extra-data claim.
  `binding` names the signer, the X25519 key, the chain and the market.

**Operational caveat.** EigenCompute storage is ephemeral. Private records are encrypted under a
key derived from the app's stable mnemonic, but the files are lost when the VM is replaced. After
a replacement, sellers must re-upload, and the relay cannot deliver versions it no longer holds;
buyers then fall back to `refundUndelivered`. Sealed backup and restore is future work.
