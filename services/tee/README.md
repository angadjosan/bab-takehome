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
| `harnessRunner.ts` | Client for the open-source reference harness `harness/envmarket_coding` (Prime Intellect `verifiers` 0.3.1), run as a subprocess (`--digest`, run, `--regrade`) per harness/README.md. It runs one pass@1 episode per (model, task). This replaced the former TypeScript tool loop, which has been deleted. |
| `validator.ts` | Fixed versioned prompt, bounded JSON schema, 120-word / 1000-byte render, output screening. |
| `preview.ts` | `POST /preview/:versionId`: on-chain terms must match the upload. Runs the panel and the validator, builds `report.json`, signs `PreviewReport`, submits `attachReport`. |
| `relay.ts` | On `Purchased`: build the wrapper, wrap `K_bundle` to `buyerEncPubKey` (EMKW2, aad = wrapperHash), persist, sign `DeliveryReceipt`, then submit `recordDelivery`. |
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
| `GET /preview/quote/:versionId` | Signed quote `{quote, quoteHash, signature}`. `quoteHash` = sha256 of the canonical quote JSON, signed EIP-191 with the raw hash. The quote holds `cached`, `episodes`, `estimatedCostUsd`, `quoteUsd`, `worstCaseUsd`, `feeUsdc` (base units), `minPreviewFee`, `estimatedRunSec` and `validUntil` (15 min). The seller then calls `requestPreview(versionId, feeUsdc, quoteHash)`. |
| `POST /preview-cache/import` | Imports a sealed cache export (`scripts/export-preview-cache.ts`). The entry must be sealed to this service's key and signed by it or by a `PREVIEW_CACHE_TRUSTED_SIGNERS` address. |
| `GET /preview-cache` | Public metadata of cached runs: key, bundleHash, models, original run and attestation kind. |
| `GET /reports/:versionId` | The signed report. Returns 202 `{status:"running"}` while running and 500 `{status:"failed"}` on failure. |
| `POST /preview/:versionId/attach` | Submits `attachReport` for a stored report (for `SUBMIT_TXS=0` runs or a failed attach). |
| `GET /deliveries/:purchaseId` | `{wrapper (canonical JSON), wrapperHash, wrappedKey (base64 EMKW2), wrappedKeyHash, ciphertextUrl, bundleHash, relay, deliveredTx}`. Served only when the purchase is Delivered on-chain with the same `wrapperHash` and `wrappedKeyHash`. |
| `POST /evidence-upload` | Body `{content}` \| `{base64}` \| any JSON object. Returns `{evidenceHash}`, the sha256 of the stored bytes; pass it to `openDispute`. Stored privately. |
| `POST /evidence/:disputeId` | Body `{juror, message, signature, encPubKey?}`. `message` = shared `evidenceAuthMessage(...)`, EIP-191-signed by the juror. Returns `{packet, packetHash, packetSignature}`, or the packet encrypted to `encPubKey`. |
| `GET /findings/:disputeId` | The public findings JSON; its sha256 is the on-chain `findingsHash`. |

### Upload body (`POST /seller/upload`, JSON, binary fields base64)

```jsonc
{
  "encryptedBundle":  "<EMENC1(K_bundle, canonical tar)>",
  "encryptedAudit":   "<EMENC1(K_audit, canonical tar of audit-tasks/)>",
  "wrappedBundleKey": "<EMKW2 to /health encPubKey; HPKE aad = sha256(encryptedBundle); info 'envmarket.upload.v1'>",
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

- **Harness.** Episodes run in the open-source reference harness `harness/envmarket_coding`
  (Prime Intellect `verifiers` 0.3.1 `MultiTurnEnv`). The TEE invokes
  `python -m envmarket_coding.run --bundle … --split purchased|audit --model … --seed 1337
  --temperature 0 --max-tokens … --action-budget 12 --time-budget EPISODE_TIME_SEC --sandbox docker|unshare
  [--netdeny runtime/netdeny.py] --venv <grader venv>` once per split, with all panel models.
- **Agent phase.** Inside the harness sandbox, `python -m grader.env serve` runs offline over a
  kit holding only `src/`, `grader/` and this task's statement, overlay and visible tests. Hidden
  tests, solutions and other tasks are absent. The tools are generated from the bundle manifest
  (`list_files`, `read_file`, `write_file`, `run_visible_tests`, `submit`).
- **Grade phase.** A separate sandboxed process runs `python -m grader.grade` with the hidden tests.
- **Records.** Each episode record (`status`, `solved`, `termination`, `grade`, `finalFiles`, `usage`,
  `transcriptHash`) is mapped onto the TEE's stored episode. A model/task pair the harness never
  reported counts as an infra failure. Plaintext records and transcripts are moved into the
  encrypted store and deleted.
- **Scoring.** Budget exhaustion, timeouts and missing submits count as failures. Infra failures
  are counted as attempted, not solved, and also reported in `infraFailures`. Scores are rounded
  to 5 pp, with purchased and audit reported separately.
- **Validator.** `deepseek-v4-pro-0813` reads the environment under the fixed prompt. It is the
  first servable candidate: the pinned `deepseek-v4-pro` is listed by Fireworks but not served, and
  the substitution is disclosed. Its output is
  screened for ≥8-token copied spans, code, paths, task ids and identifiers, long base64/hex, and
  obedience to embedded instructions. If screening fails, the report says "Explanation withheld by output screening." with the reasons.
- **Report.** Per-task outcomes and transcripts stay in private records. Job statuses mean "graded"
  or "infra_failure", never solved or unsolved, so jobs don't leak per-task outcomes.
  `protocol.harnessDigest` is the sha256 of a published commitment (`/blobs/<digest>`) over:
  - the protocol spec, including the harness's own `harnessDigest` (a hash of its source and lock),
    its `protocol`, decoding and the reproducibility tolerances;
  - the bundle's `toolsDigest`.

  `protocol.promptDigest` is the harness `promptDigest`, and the protocol id is `envmarket.preview.v2`.

**Relay.** The watcher sees `Purchased`. The service builds the wrapper (`relay` = its signer),
wraps `K_bundle` to `buyerEncPubKey` (shared `wrapKeyAsync`: EMKW2, HPKE via @hpke/core, with
`wrapperHash` as AAD) using a stored ephemeral key, and persists the record
*before* signing. It then signs `DeliveryReceipt` and submits `recordDelivery`. After a restart
it reuses the stored record, so the on-chain hashes always match what it serves.

**Mechanical verifier.**
- *BrokenOrHashMismatch.* Rechecks the ciphertext hash, bundle hash and wrapper, and re-derives
  the delivered wrapped key byte for byte. Any mismatch confirms every masked task. Otherwise it
  rebuilds and runs `check_tasks.py` twice. A masked task is confirmed only if both runs show a
  grader import failure, a crash, no collected hidden tests, or hidden tests failing on the
  delivered reference solution.
- *PreviewNotReproducible.* Both halves run in the harness. (1) `--regrade` re-grades every
  original episode's stored final workspace with a tolerance of 0: score and graded tree digest
  must match. (2) A harness re-run of the masked tasks, once per model, with a per-model pass-rate
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

## Paid previews, quotes and the preview cache

**Payment.** `EnvMarket.attachReport` reverts unless the seller has paid for the preview. The flow is:
1. `GET /preview/quote/:versionId`;
2. `requestPreview(versionId, feeUsdc, quoteHash)` on-chain;
3. `POST /preview/:versionId`.

Before any inference, the service checks `previewInfo(versionId)`:
- paid, not released and not reclaimed;
- `quoteHash` is a quote this service issued for this version;
- `fee ≥ quote.feeUsdc`;
- paid before `quote.validUntil`;
- the estimated run fits before `previewDeadline(versionId)`.

If any check fails it returns HTTP 402 (or 409 for the deadline). `attachReport`, which releases the fee to `previewFeeRecipient`, is submitted immediately after signing.

**Cost** (`src/cost.ts`) uses the constants and formulas in `docs/PREVIEW_COST.md`:
- `quote = ceilToCent(episodeCost × 1.5 + validatorCost)`;
- `worstCase` = every episode at its full budget, plus the validator at its ceiling;
- a cached run's fee is the contract's `minPreviewFee`.

The harness enforces the per-model `fullBudgetIn`/`fullBudgetOut` token bound. It never starts a call that could push cumulative prompt tokens past `fullBudgetIn` (estimated at 3 chars/token), and it caps `max_tokens` at the remaining `fullBudgetOut`. So `worstCase` is a real bound. An episode stopped this way counts as failed.

Actual usage (prompt, cached prompt and completion tokens) and USD cost are stored per episode and for the validator in the private run records. `/preview` and `/reports` return `inferenceCostUsd` (actual; 0 when a cached run is reused) and `feePaidUsdc`. They go into `report.json` too once the shared schema has those fields.

**Inference runs once per environment.** A completed run (with no infra failures) is stored as a signed, encrypted cache entry. Its key is `(bundleHash, auditRoot, protocol id, harnessDigest, promptDigest, validator promptHash, panel model ids, validator model)`; versionId, market and chain are not part of it. Any later version with the same key, on any listing, contract or chain, is served from it:
- `report.json` is rebuilt for the new `versionId` with the original jobs, run dates and scores, and freshly signed;
- it records `cachedFrom {originalRunAt, originalVersionId, originalChainId}` once shared's schema has the field, and a disclosure note in `uncertainty` until then;
- reuse never upgrades trust: a run made in local dev yields reports labeled `none-local-dev`, even when an EigenCompute deployment re-signs them.

To seed another deployment, run:

```bash
tsx scripts/export-preview-cache.ts --data-dir .data --to-url https://<tee> --out ./cache-export --post
```

That seals each entry to the target's X25519 key, and the target must list the producer address in `PREVIEW_CACHE_TRUSTED_SIGNERS`. Alternatively, copy the files into the target's `PREVIEW_CACHE_IMPORT_DIR`. `PreviewNotReproducible` disputes still re-run real inference.

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
| `CHAIN_ID` | sealed `.env` | `84532` (Base Sepolia, the demo target); `8453` (Base mainnet) is still supported; `31337` for anvil. |
| `BASE_SEPOLIA_RPC` / `BASE_RPC` / `RPC_URL` | sealed `.env` | RPC endpoint (84532 / 8453 / explicit override). |
| `MARKET_ADDRESS`, `START_BLOCK` | sealed `.env` | EnvMarket address and the watcher's start block. They can also come from `deployments/<chainId>.json` via `DEPLOYMENTS_DIR`. |
| `PUBLIC_URL` | sealed `.env` | Base URL advertised for blobs (listing `uri`), e.g. `https://<domain>` or `http://<app ip>:8080`. |
| `EIGEN_APP_ID` (or `EIGEN_APP_ID_PUBLIC`), `EIGEN_IMAGE_DIGEST`, `EIGEN_ENVIRONMENT` (`sepolia` default \| `mainnet-alpha`; selects dashboard + AppController), `EIGEN_VERIFY_URL` | public `.env` | Shown in reports and `/attestation`. |
| `KMS_SERVER_URL`, `KMS_PUBLIC_KEY` | injected by EigenCompute | Used for the runtime attestation JWT. |
| `PORT` (8080 in the image, 8787 locally), `HOST`, `DATA_DIR` (`/data` in the image, `./.data` locally) | image | HTTP port, bind host and storage directory. |
| `SUBMIT_TXS` (1), `WATCHER` (1), `POLL_MS` | optional | Transaction submission, chain watcher and poll interval. |
| `PREVIEW_CONCURRENCY` (6), `EPISODE_TIME_SEC` (300), `MAX_TOKENS` (8192), `VALIDATOR_MODEL` | optional | Preview and validator tuning. |
| `PREVIEW_RATE_PER_LISTING_PER_HOUR` (3), `PREVIEW_RATE_GLOBAL_PER_HOUR` (12) | optional | Preview rate limits. |
| `SANDBOX` (`auto`/`docker`/`unshare`), `SANDBOX_IMAGE` | optional | Sandbox selection. |
| `HARNESS_DIR`, `HARNESS_PYTHON` | image | The reference harness checkout and its Python. The image uses `/app/harness/envmarket_coding` and `/opt/harness-venv/bin/python`; locally the default is `harness/envmarket_coding/.venv`. Without a harness, previews and PreviewNotReproducible checks return 503. |
| `LLM_PROVIDER=ollama`, `LOCAL_AGENT_MODEL`, `LOCAL_VALIDATOR_MODEL` | local dev only | Harness check without a Fireworks key. It is labeled in the report and refused when `MNEMONIC` is set. |
| `PREVIEW_CACHE_TRUSTED_SIGNERS` | optional | Comma-separated producer addresses whose sealed preview-cache exports are accepted (this service's own signer is always trusted). |
| `PREVIEW_CACHE_IMPORT_DIR` | optional | A directory of sealed exports, imported at startup. |
| `VALIDATOR_MODEL` | optional | Exact validator id. By default the pinned `deepseek-v4-pro` is probed first; if it isn't served, the service uses its dated snapshot `-0813`, then the newest serving DeepSeek, then gpt-oss, and records the substitution. |
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

## Deploy to EigenCompute (`sepolia`, the demo target)

All testnet (BUILD_SPEC "Deployment target — FINAL"). Contracts are on Base Sepolia (84532, TestUSDC with
a faucet). The TEE runs in EigenCompute's `sepolia` environment: the AppController is on Ethereum Sepolia,
and it's the same real Intel TDX + KMS + attestation. Every environment-specific value comes from
`EIGEN_ENVIRONMENT`, so `mainnet-alpha` works by changing that one variable.

The CLI is `ecloud` (`@layr-labs/ecloud-cli@1.0.0`, run with `npx -y @layr-labs/ecloud-cli@1.0.0 …`).
`ecloud --help` and `ecloud compute app deploy --help` were checked. **Nothing was deployed or paid for.**

1. Accounts:
   - `docker login` to a registry EigenCompute can pull from;
   - `ecloud auth login` (or `ecloud auth migrate` from eigenx);
   - `ecloud billing subscribe` (card or USDC);
   - `ecloud compute env set sepolia`;
   - a little Sepolia ETH in the eigen wallet for the AppController txs (billing credits are wallet-wide).
2. Build and push from the **repo root** (linux/amd64):
   ```bash
   docker buildx build --platform linux/amd64 -f services/tee/Dockerfile -t docker.io/<you>/envmarket-tee:v1 --push .
   ```
3. Write a sealed env file, `services/tee/.env.tee`. It is gitignored by the repo's `.env.*` rule; never commit it.
   ```bash
   FIREWORKS_API_KEY=...
   CHAIN_ID=84532
   BASE_SEPOLIA_RPC=https://sepolia.base.org
   MARKET_ADDRESS=0x...          # from deployments/84532.json
   START_BLOCK=...
   PUBLIC_URL=http://<ip>:8080   # fill after first deploy, then upgrade
   EIGEN_ENVIRONMENT=sepolia
   ```
4. Deploy (TDX SKU):
   ```bash
   npx -y @layr-labs/ecloud-cli@1.0.0 compute app deploy --non-interactive --name envmarket-tee \
     --image-ref docker.io/<you>/envmarket-tee:v1 --env-file services/tee/.env.tee \
     --instance-type g1-standard-4t --log-visibility public --environment sepolia
   npx -y @layr-labs/ecloud-cli@1.0.0 compute app info envmarket-tee --address-count 1 --environment sepolia   # app id, IP, EVM address
   ```
5. Check the deployment:
   - `curl http://<ip>:8080/health`: `signer` must equal the EVM address from `app info`.
   - `curl http://<ip>:8080/attestation?refresh=1`: must show `kind: "eigencompute-tdx"`, a JWT and `quoteDigest`.
6. As the EnvMarket owner on Base Sepolia, run `setRunner(signer,true)`, `setRelay(signer,true)` and
   `setVerifier(signer,true)`. Then send the signer a little Base Sepolia ETH for gas; it submits
   `attachReport`, `recordDelivery` and `resolveMechanical`.
7. Add `EIGEN_APP_ID_PUBLIC=<app id>`, `EIGEN_IMAGE_DIGEST=<digest>` and `PUBLIC_URL` to the env
   file, then run `ecloud compute app upgrade envmarket-tee --image-ref … --env-file …`. The same
   app id keeps the same mnemonic and signer.
8. Optionally, add TLS with `ecloud compute app configure tls` (needs `DOMAIN` and an A record).

**Verifying attestation:**
- The app id and image digest are on the dashboard: `https://verify-sepolia.eigencloud.xyz/app/<appId>`
  (`/attestation` shows `verifyUrl`). That URL pattern is an assumption; the dashboard lists app id,
  releases and digests.
- Read AppController `0x0dd810a6ffba6a9820a10d97b659f07d8d23d4E2` on Ethereum Sepolia (for
  `mainnet-alpha`: `0xc38d35Fc995e75342A21CBd6D770305b142Fbe67` on Ethereum mainnet). `/attestation`
  reports `appController` and `appControllerChainId`.
- Check the JWT from `/attestation`: validate its signature against `kmsPublicKey`, check
  `aud = "envmarket-tee"`, and recompute `sha512(binding)` against the token's extra-data claim.
  `binding` names the signer, the X25519 key, the chain and the market.

**Operational caveat.** EigenCompute storage is ephemeral. Private records are encrypted under a
key derived from the app's stable mnemonic, but the files are lost when the VM is replaced. After
a replacement, sellers must re-upload, and the relay cannot deliver versions it no longer holds;
buyers then fall back to `refundUndelivered`. Sealed backup and restore is future work.
