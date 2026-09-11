# Build Spec — RL Environment Market (implementation contract for all builders)

This is the implementation contract for `docs/RL_ENV_MARKET.md`. Every builder must follow the
interfaces here exactly so parallel work integrates. If you must deviate, record the change in
the "Change log" at the bottom of this file in the same commit.

**Hard rule from the founder: nothing is mocked.** Testnet (Base Sepolia, a test ERC-20 standing in
for USDC) is fine, but every component must really work: real TEE deployment + attestation (Phala
Cloud dstack Intel TDX; see "TEE — FINAL" below), real LLM inference for reference runs / validator / jurors, real
on-chain randomness for juror selection, real encryption and delivery, real disputes and
settlement. A local dev mode is allowed (e.g. running the TEE service on a laptop for tests), but
it must be labeled truthfully in reports (`attestation.kind = "none-local-dev"`) and is never the
demo path.

## Deployment target — FINAL (founder decision, 2026-09-11): ALL TESTNET

Supersedes the mainnet section below (kept for history). TAKEHOME.md requires a public testnet.
- **Contracts: Base Sepolia (84532)**, explorer https://sepolia.basescan.org, RPC `BASE_SEPOLIA_RPC=https://sepolia.base.org`.
  Token = our `TestUSDC` ("Test USDC (no value)", 6 decimals) with the public rate-limited `faucet()` so
  reviewers can try every flow from the web app. Params = the demo table (price 100 tUSDC etc.) unless noted.
- **TEE: Phala Cloud (dstack, Intel TDX)**. This supersedes EigenCompute; see "TEE — FINAL" below.

## TEE — FINAL (founder decision, 2026-09-11): Phala Cloud dstack, Intel TDX

Supersedes the EigenCompute `sepolia` choice above: EigenCompute's app quota
(`AppController.getMaxActiveAppsPerUser`) needs manual EigenLabs approval and was still 0.
- **Platform:** Phala Cloud dstack CVM, `tdx.large` (4 vCPU / 8 GB), production OS `dstack-0.5.9`
  (never a DEV image), default Phala KMS (`--kms phala`: no wallet, no chain coupling).
  - CLI `phala@1.1.22`; `services/tee/scripts/phala-deploy.sh build|deploy|update`.
  - Compose: `services/tee/phala/docker-compose.yml`, image pinned by digest, dstack socket mounted,
    `/data` volume, `cap_add: SYS_ADMIN` + `seccomp:unconfined` for the unshare sandbox layer.
  - Live record: `deployments/phala-tee.json`.
- **Selector:** `TEE_VENDOR=eigencompute|phala|local`. When unset: `MNEMONIC` → eigencompute;
  `/var/run/dstack.sock` → phala; else local. There is no silent fallback.
- **Keys (phala):** `@phala/dstack-sdk` **0.5.8, pinned** (v0 `GetKey`; the unreleased 0.6 v1
  derivation differs). `GetKey("envmarket/tee/v1", "envmarket.tee.root")` → 32-byte secp256k1
  signer, deterministic per app id. X25519 / storage keys = HKDF of those bytes, exactly as in the
  other modes. `keySource = "dstack-kms"`.
- **Attestation (phala):** new report kind **`phala-dstack-tdx`** (shared `ATTESTATION_KINDS`).
  - Binding = canonical `{type: "envmarket.tee.binding.v1", vendor: "phala", signer, encPubKey, chainId, market, appId}`.
  - Quote = dstack `GetQuote(sha512(binding))`: a raw Intel DCAP TDX quote with 64-byte `report_data` at quote offset 568.
  - `quoteDigest = sha256(quote bytes)`, `verifyUrl = https://trust.phala.com/app/<appId>`.
  - `/attestation` also serves `eventLog`, `composeHash`, `appCompose`, `osImageHash` and the KMS key signature chain.
  - Per-report quote over `sha512({type: "envmarket.report.attestation.v1", versionId, reportHash})`.
- **Third-party verification** (`apps/web` `/api/attestation/verify`; server-side because Phala's API has no CORS):
  - Phala's verifier (`POST https://cloud-api.phala.com/api/v1/attestations/verify {hex}` → `quote.verified`);
  - report_data = sha512(binding);
  - RTMR3 replay: dstack 0.5.9 serves empty event digests; recompute
    `sha384(u32le(type)‖":"‖event‖":"‖payload)`;
  - app-id / compose-hash events;
  - compose pins the image by digest and equals the published record;
  - `binding.signer` holds isRunner / isRelay / isVerifier on-chain (read by the route itself).
- **Trust:** the Phala KMS operator is trusted, and the developer can push a new compose/image to the
  same app. The signer stays the same across updates (checked live), but a new app id means a new signer.
- **EigenCompute** stays a documented, working alternative (`TEE_VENDOR=eigencompute`,
  `scripts/eigen-deploy.sh`, unchanged binding and JWT attestation). It is blocked on quota.
- **Inference: Fireworks** — unchanged, real models (glm-5p3, kimi-k3, qwen3p8-max; validator deepseek-v4-pro-0813).
- Web default `NEXT_PUBLIC_CHAIN_ID=84532` with faucet button. Mainnet code paths stay supported but unused.

## Deployment target (founder decision, 2026-09-10 — supersedes "Base Sepolia"/"TestUSDC" below)

- **Contracts: Base mainnet (chainId 8453)**, explorer https://basescan.org. Payment token = **real
  native USDC on Base** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals — verify with
  `cast call <addr> "symbol()(string)" --rpc-url https://mainnet.base.org` before use). Amounts are
  tiny (see mainnet params). `TestUSDC` is kept ONLY for local anvil tests (chainId 31337); on
  8453 the deploy script takes `TOKEN_ADDR` and deploys no token. No faucet on mainnet.
- **TEE: EigenCompute mainnet** (`ecloud` CLI, `@layr-labs/ecloud-cli`; app registered on
  Ethereum mainnet; Intel TDX / GCP confidential VM). App wallet from the KMS `MNEMONIC` env var
  is the runner/relay/verifier signer registered in EnvMarket. It sends txs to Base mainnet.
  Attestation evidence: app id + image digest on the EigenCloud verify dashboard and the
  AppController contract; the app also serves its attestation token at `/attestation`.
- **Inference: Fireworks AI** (`https://api.fireworks.ai/inference/v1`, OpenAI-compatible
  chat completions + tool calling, `Authorization: Bearer $FIREWORKS_API_KEY`), called from inside
  the TEE for the reference panel and validator, and by the juror processes. (Supersedes an earlier
  OpenRouter choice — any OpenRouter code should become a generic provider config defaulting to
  Fireworks.) Panel = the newest real Fireworks model ids (`accounts/fireworks/models/...`) in the
  GLM, Kimi and Qwen families (resolve at runtime from `GET /inference/v1/models`, record the exact ids in the report; the
  requested names "GLM 5.3 / Kimi K3 / Qwen 3.8" are recorded as `requested`). Validator = a
  different model family (e.g. a DeepSeek or gpt-oss model on Fireworks), recorded in the report.
  **Verified available on Fireworks (2026-09-10):** the requested panel exists exactly —
  `accounts/fireworks/models/glm-5p3` (GLM 5.3), `accounts/fireworks/models/kimi-k3` (Kimi K3),
  `accounts/fireworks/models/qwen3p8-max` (Qwen 3.8). Pin these ids (resolver only as fallback).
  Validator: `accounts/fireworks/models/deepseek-v4-pro-0813` (the undated id is listed but not served). Jurors (diverse, disclose shared bases):
  juror1 `accounts/fireworks/models/deepseek-v4p1-flash`, juror2 `accounts/fireworks/models/gpt-oss-120b`,
  juror3 `accounts/fireworks/models/glm-5p2`.
- Env names: `BASE_RPC=https://mainnet.base.org`, `CHAIN_ID=8453`. Local tests: anvil 31337.

Mainnet params (override the demo table below on 8453) — sized for a 5 USDC total demo budget
(founder funded 5 USDC): listing price 0.5 USDC, collateral 0.5 USDC per sale, bondFloor 0.05,
bondCap 0.5, caseFee 0.10, participationFee 0.02, jurorStake 0.25 USDC, other bps/windows
unchanged (challenge 300 s, delivery 600 s, commit/reveal 180 s each). Demo funding plan from the
DEPLOYER's 5 USDC: seller 1.0 (collateral for 2 concurrent sales), buyer 0.7, buyer2 0.6, jurors
0.3 each (0.9), spare ~1.8.

## Repo layout

```
contracts/                 Foundry project: TestUSDC.sol, EnvMarket.sol, tests, deploy script
packages/shared/           TypeScript lib (@envmarket/shared): crypto, commitments, EIP-712, ABI, config, LLM client, types
seller-workspace/py-repair-kit/   The seller's plaintext environment (synthetic demo content): source, tasks, hidden tests, audit tasks
services/tee/              The trusted service deployed to EigenCompute: preview runner, validator, key-delivery relay, mechanical verifier, evidence server, blob storage, HTTP API
services/jurors/           Three AI juror agent processes (commit-reveal on-chain)
agents/                    Seller agent + buyer agent CLIs (autonomous flows) and the e2e demo orchestrator
apps/web/                  Next.js app (deployed to Vercel): listings, preview report, purchase/dispute timelines, reputation, finalize button
deployments/               <chainId>.json with deployed addresses + start block (committed)
```

Language/runtime: TypeScript on Node 22 run with `tsx` (no build step needed for services/agents),
`viem` for chain access, Python 3.12 for the environment itself. Each package is standalone with its
own `package.json` + lockfile (NO root npm workspace — avoids lockfile races between parallel
builders). Packages depend on shared via `"@envmarket/shared": "file:../../packages/shared"`
(adjust relative path). `packages/shared` exports TypeScript source directly (`"exports": {".": "./src/index.ts"}`).
The web app does not depend on shared; it gets ABI/addresses/public docs via `scripts/sync-web.sh`.

Secrets live in repo-root `.env` (gitignored). Variables: `DEPLOYER_PK/ADDR, SELLER_PK/ADDR,
BUYER_PK/ADDR, BUYER2_PK/ADDR, RUNNER_PK/ADDR, RELAY_PK/ADDR, VERIFIER_PK/ADDR, JUROR{1,2,3}_PK/ADDR,
BUYER_ENC_SK/PK, BUYER2_ENC_SK/PK, BASE_SEPOLIA_RPC, CHAIN_ID`. In the TEE, the service's signing key
comes from the EigenCompute KMS-provided mnemonic instead of RUNNER/RELAY/VERIFIER keys.

Git: builders commit only their own paths (`git add <your dirs>`), small commits, message ends with
a blank line + `Claude-Session: https://claude.ai/code/session_01YUsWauWzmr1tK9SUbgQWUy`. If
`.git/index.lock` exists, wait a few seconds and retry — other builders commit concurrently. Never
`git add -A`, never commit `.env`, never rewrite history, never push unless told.

## Units and parameters

Token: `TestUSDC` ERC-20, 6 decimals, symbol `tUSDC`, name "Test USDC (no value)". Owner can mint;
also a rate-limited public `faucet()` (1,000 tUSDC per address per 24h) so anyone can try the app.

| Param | Demo value | Notes |
|---|---|---|
| `challengeWindow` | 300 s | 604800 in production; frozen per purchase |
| `deliveryWindow` | 600 s | pre-delivery timeout → full refund |
| `refundCapBps` | 5000 | post-delivery refunds ≤ 50% of price |
| `penaltyThresholdBps` | 500 | confirmed defective tasks > 5% of taskCount → extra slash |
| `penaltyBps` | 1000 | extra slash = 10% of price, from seller collateral → neutral reserve |
| `feeBps` | 200 | 2% marketplace fee on retained seller proceeds → treasury |
| `bondFloor` / `bondCap` | 5 / 50 tUSDC | bond = clamp(requestedRefund, floor, cap) |
| `caseFee` | 6 tUSDC | paid by the losing side; funds jurors (FalseDescription) or verifier op (mechanical) |
| `participationFee` | 1 tUSDC | per revealing juror, out of caseFee |
| `jurorStake` | 20 tUSDC | locked per seat per case |
| `minoritySlashBps` | 2000 | of seat stake, paid to majority |
| `nonRevealSlashBps` | 5000 | of seat stake → neutral reserve |
| `commitWindow` / `revealWindow` | 180 s / 180 s | |
| seats | 3 (round 1), 3 fresh (replacement round 2) | appeal to 7 jurors = future work |

All params are owner-settable for FUTURE purchases/disputes only; every purchase snapshots the
values it depends on.

## Contract: `EnvMarket.sol` (single contract) + `TestUSDC.sol`

Solidity ^0.8.24, OpenZeppelin (ERC20, SafeERC20, EIP712, ECDSA, Ownable). Custom errors. Emits
events for every state change.

### Enums
```solidity
enum PurchaseState { None, Funded, Delivered, Disputed, Refunded, Settled }
enum Ground { None, BrokenOrHashMismatch, FalseDescription, PreviewNotReproducible }
enum DisputeStatus { None, AwaitingSelection, Voting, Resolved }
enum Verdict { None, Uphold, Reject }   // Uphold = buyer wins
```

### Roles
- `owner` (deployer): sets params, `setRunner(addr,bool)`, `setRelay(addr,bool)`, `setVerifier(addr,bool)`, `approveJuror(addr,bool)`, withdraws treasury. Reserve withdrawal is owner-only too, but tracked separately.
- runner / relay / verifier: addresses of the EigenCompute TEE app's KMS-derived signer (one address may hold all three roles). Their authority is used ONLY via EIP-712 signatures verified on-chain, so any party can submit the tx.

### Listings and versions
```solidity
struct VersionTerms {
  address seller; uint64 listingId; uint32 versionNo;
  bytes32 bundleHash;      // sha256 of canonical plaintext archive
  bytes32 ciphertextHash;  // sha256 of encrypted bundle file
  bytes32 imageDigest;     // sha256 digest of the runtime image (e.g. python:3.12-slim@sha256:...)
  bytes32 descriptionHash; bytes32 manifestHash; bytes32 licenseHash;
  bytes32 taskRoot; bytes32 auditRoot; uint16 taskCount; uint16 auditTaskCount;
  uint128 price; uint128 collateral; uint32 deliveryWindow; uint32 challengeWindow;
  bytes32 reportHash;      // set once by attachReport
  string uri;              // base URL for public docs, e.g. https://<tee-host>/blobs/
  bool active;
}
function createListing(VersionInput calldata v) returns (uint256 versionId); // new listingId, versionNo 1
function newVersion(uint64 listingId, VersionInput calldata v) returns (uint256 versionId); // seller only; old versions stay intact
function setVersionActive(uint256 versionId, bool) // seller
function attachReport(uint256 versionId, bytes32 reportHash, bytes calldata runnerSig) // anyone; sig by a runner; once per version
```
`VersionInput` = all VersionTerms fields except seller/listingId/versionNo/reportHash/active.
`versionId` is a global counter starting at 1. Purchases need a report attached and `active`.

### Seller collateral
`depositCollateral(uint256)`, `withdrawCollateral(uint256)` (≤ available). View
`sellerStake(address) → (total, reserved, available)`. Buying reserves `collateral` of the version;
settlement releases what is not slashed. Reserved collateral never backs two purchases.

### Purchases
```solidity
function buy(uint256 versionId, bytes32 buyerEncPubKey, uint256 maxPrice) returns (uint256 purchaseId);
function recordDelivery(uint256 purchaseId, bytes32 ciphertextHash, bytes32 wrappedKeyHash, bytes32 wrapperHash, bytes calldata relaySig); // anyone submits; sig by relay; before deliveryDeadline; ciphertextHash must equal the version's
function refundUndelivered(uint256 purchaseId); // anyone, Funded && now > deliveryDeadline → Refunded, full price back, collateral released
function finalize(uint256 purchaseId);          // anyone, Delivered && now > challengeDeadline && no dispute → Settled
```
`buyer != seller`. Purchase snapshots: versionId, buyer, seller, price, collateral, buyerEncPubKey,
fundedAt, deliveryDeadline, deliveredAt, challengeDeadline, and the fee/refund/penalty/bond params.
On `Settled` without dispute: seller gets `price - fee`, treasury gets `fee`, collateral released,
reputation counters update (see below).

### Disputes
```solidity
function openDispute(uint256 purchaseId, Ground ground, uint256 taskMask, bytes32 evidenceHash) returns (uint256 disputeId);
```
Buyer only, state Delivered, `now <= challengeDeadline`, one dispute per purchase, `ground != None`,
`taskMask != 0` and only bits `< taskCount`. `perTask = price / taskCount`;
`requested = min(popcount(taskMask) * perTask, price * refundCapBps / 10000)`;
`bond = clamp(requested, bondFloor, bondCap)` pulled from buyer. Purchase → Disputed (finalize blocked).

Mechanical grounds (`BrokenOrHashMismatch`, `PreviewNotReproducible`):
```solidity
function resolveMechanical(uint256 disputeId, bool upheld, uint256 confirmedMask, bytes32 findingsHash, bytes calldata verifierSig);
```
`confirmedMask ⊆ taskMask`. Loser pays `caseFee` to treasury (verifier operator cost).

`FalseDescription` (jurors):
- On open: `selectionBlock = block.number + 2`, status AwaitingSelection.
- `selectJurors(disputeId)` — anyone, once `block.number > selectionBlock`; seed =
  `keccak256(blockhash(selectionBlock), block.prevrandao, disputeId, round)`; if `blockhash` is 0
  (older than 256 blocks) re-arm `selectionBlock`. Pick 3 distinct approved jurors with free stake ≥
  `jurorStake`, excluding buyer and seller, max one seat per juror. Lock their stake. Sets
  `commitDeadline = now + commitWindow`, `revealDeadline = commitDeadline + revealWindow`. Event
  `JurorsSelected(disputeId, round, jurors[3], commitDeadline, revealDeadline)`.
- `commitVote(disputeId, bytes32 commitment)` seated juror, `now <= commitDeadline`, once.
  `commitment = keccak256(abi.encode(disputeId, round, uint8(verdict), salt, juror))`.
- `revealVote(disputeId, Verdict verdict, bytes32 salt)` after commitDeadline, `now <= revealDeadline`, must match.
- `tallyDispute(disputeId)` anyone, after revealDeadline (or earlier if all seats revealed).
  If ≥ 2 reveals and a strict majority exists → resolve. Otherwise (insufficient reveals): if round 1,
  slash non-revealers, start round 2 (fresh selection, excluding round-1 jurors); if round 2 also
  insufficient → fallback: dispute Rejected-without-fault: bond returned in full, no refund, purchase
  settles normally (precommitted bounded policy; recorded as `FallbackNoQuorum`).
- Juror money: each revealing juror gets `participationFee` from `caseFee`; the remainder of caseFee
  plus `minoritySlashBps` of each minority seat's stake is split equally among majority seats
  (dust → reserve). Non-revealers lose `nonRevealSlashBps` of seat stake → reserve. Unslashed stake unlocks.

Settlement (all grounds) — `upheld` with `confirmedMask` (jurors: confirmedMask = taskMask):
- `newMask = confirmedMask & ~remediedMask[purchase]`; `refund = min(popcount(newMask)*perTask, cap - alreadyRefunded)`; mark remedied.
- Buyer receives `refund` + full bond back. Seller-side: `retained = price - refund`; fee = retained*feeBps; seller gets `retained - fee`.
- Seller collateral pays `caseFee`; if `popcount(confirmedMask) * 10000 > taskCount * penaltyThresholdBps`,
  additionally slash `price * penaltyBps / 10000` → reserve. Remaining collateral released.
- `Reject`: buyer bond → `caseFee` to jurors/treasury, remainder → reserve (never to the seller). Seller gets `price - fee`. Collateral released.
- Purchase → Settled exactly once. Event `DisputeResolved(disputeId, verdict, refund, sellerProceeds, penalties)` and `PurchaseSettled(...)`.

### Reputation
- `rate(uint256 purchaseId, uint8 stars, bytes32 commentHash)` — buyer, state Settled, was delivered, once. 1–5.
- Per version: `ratingSum, ratingCount, settledCount, retainedVolume, disputesOpened, disputesUpheld`.
- Per seller: `qualifyingTx` (delivered + settled + retained > 0), `retainedVolume`, `weightedRatingSum` (Σ retained×stars), `ratedRetained` (Σ retained for rated purchases), `disputesOpened`, `disputesUpheld`, `fullRefunds`.
- View `sellerScore(seller) → (qualifyingTx, eligible = qualifyingTx >= 100, weightedRatingSum, ratedRetained)`. UI shows "New seller — N/100 transactions · Seller stake: X tUSDC" until eligible.

### Accounting invariant (must be tested)
`token.balanceOf(market) == Σ escrowed prices (Funded/Delivered/Disputed) + Σ seller collateral totals + Σ open bonds + Σ juror stakes + treasury + reserve`.

### EIP-712
Domain: `name = "EnvMarket"`, `version = "1"`, chainId, verifyingContract = EnvMarket.
```
PreviewReport(uint256 versionId,bytes32 bundleHash,bytes32 reportHash)
DeliveryReceipt(uint256 purchaseId,bytes32 buyerEncPubKey,bytes32 ciphertextHash,bytes32 wrappedKeyHash,bytes32 wrapperHash)
MechanicalFinding(uint256 disputeId,bool upheld,uint256 confirmedMask,bytes32 findingsHash)
```

### Events (names are the contract; args may be extended)
`ListingCreated(listingId, versionId, seller)`, `VersionCreated(listingId, versionId, versionNo, bundleHash, descriptionHash)`,
`ReportAttached(versionId, reportHash, runner)`, `CollateralDeposited/Withdrawn(seller, amount)`,
`Purchased(purchaseId, versionId, buyer, price, buyerEncPubKey, deliveryDeadline)`,
`Delivered(purchaseId, ciphertextHash, wrappedKeyHash, wrapperHash, challengeDeadline)`,
`RefundedUndelivered(purchaseId)`, `DisputeOpened(disputeId, purchaseId, ground, taskMask, requested, bond, evidenceHash)`,
`JurorsSelected(...)`, `VoteCommitted(disputeId, round, juror)`, `VoteRevealed(disputeId, round, juror, verdict)`,
`MechanicalResolved(disputeId, upheld, confirmedMask, findingsHash)`, `DisputeResolved(...)`, `PurchaseSettled(purchaseId, sellerProceeds, refund, fee)`,
`Rated(purchaseId, versionId, seller, stars, commentHash)`, `JurorRegistered/StakeChanged`.

## Commitments and file formats (`packages/shared`)

Hashes: file/content digests are `sha256` rendered as `0x` + 64 hex (bytes32). On-chain structural
hashes use `keccak256`.

**Canonical archive** (bundleHash): deterministic POSIX ustar tar of the purchased payload dir —
entries sorted by path, mtime 0, uid/gid 0, uname/gname "", mode 0644 (0755 for dirs/executables),
no compression. Contents: `manifest.json`, `src/`, `tasks/<taskId>/task.json`, `tasks/<taskId>/tests/` (hidden tests),
`grader/`, `requirements.lock`, `IMAGE_DIGEST`. Audit tasks are NOT in it.

**Task leaf**: `leaf = keccak256(abi.encode("envmarket.task.v1", environmentVersion(string), taskId(string), sha256(taskBytes)(bytes32), graderDigest(bytes32), salt(bytes32)))`
where taskBytes = canonical tar of `tasks/<taskId>/`. Salts: 32 random bytes each, stored in the
seller's private `salts.json` (never delivered; audit salts never leave the TEE).
**Merkle root**: `@openzeppelin/merkle-tree` `SimpleMerkleTree` over the leaves in taskId order (`sortLeaves: false`): sorted-pair keccak256, OZ complete-tree layout, proofs verify with OZ `MerkleProof.verify`.
`auditRoot` built the same way over audit tasks with domain `"envmarket.audit.v1"`.

**Encryption**: AES-256-GCM. File format `"EMENC1"` (6 bytes) ‖ nonce (12) ‖ ciphertext ‖ tag (16).
Bundle key `K_bundle` and audit key `K_audit` are independent random 32-byte keys.

**Delivery wrapper** (buyer-specific, around the unchanged ciphertext): canonical JSON (RFC 8785 JCS: sorted keys,
no whitespace) `{"type":"envmarket.delivery.v1","purchaseId":"..","chainId":..,"market":"0x..","buyer":"0x..","buyerEncPubKey":"0x..","versionId":"..","bundleHash":"0x..","ciphertextHash":"0x..","issuedAt":<unix>,"relay":"0x.."}`.
`wrapperHash = sha256(wrapperJSON)`.

**Wrapped key** (EMKW2 = HPKE, RFC 9180): mode_base single-shot seal of K_bundle to `buyerEncPubKey` with suite
DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM, `info = "envmarket.keywrap.v1"`, `aad = wrapperHash bytes`;
blob = `"EMKW2"` ‖ enc (32) ‖ ciphertext (32-byte key ‖ 16-byte tag) = 85 bytes. `wrappedKeyHash = sha256(blob)`.
Buyer encryption keys are X25519 (separate from wallet keys), `bytes32` on-chain.

**Manifest** (`manifest.json`, schemaVersion "1"): fields exactly as the table in RL_ENV_MARKET.md
"The environment interface" (schemaVersion, environmentType, bundleDigest, imageDigest, taskRoot,
taskCount, auditRoot, auditTaskCount, entrypoints, schemas, grader, resources, determinism,
networkPolicy, referenceProtocol, license, provenance, conflicts, commercialTerms). `bundleDigest`
inside the manifest refers to the payload excluding manifest.json itself (define: sha256 of the canonical tar of the payload without manifest.json).

**Description** (`description.md` + `description.json` with an array of numbered, specific,
checkable `claims`). descriptionHash = sha256 of description.json.

**Preview report** (`report.json`, canonical JSON; reportHash = sha256):
```
{ type:"envmarket.report.v1", versionId, environmentVersion, bundleHash, ciphertextHash, taskRoot, auditRoot,
  protocol:{ id, harnessDigest, promptDigest, decoding:{temperature, seed, maxTokens}, actionBudget, timeBudgetSec, successRule:"all hidden tests pass" },
  models:[ { requested:"GLM 5.3", resolved:"<exact model id served>", provider, status:"run"|"unavailable", purchased:{attempted, solved, pass1Rounded}, audit:{attempted, solved, pass1Rounded}, infraFailures } ],
  uncertainty:"n=5 tasks; rounding to 5pp hides little",
  validator:{ model, promptVersion, promptHash, explanation, screening:{passed, reasons[]} },
  jobs:[ {jobId, startedAt, finishedAt, status} ],  // all scheduled jobs, incl. failed
  runtime:{ imageDigest, sandbox:"...", network:"none" },
  attestation:{ kind:"eigencompute-tdx"|"none-local-dev", appId, signer, quoteDigest, verifyUrl },
  signer, createdAt }
```
Private unrounded per-task outcomes are stored only inside the TEE service (private run records).

## TEE service HTTP API (`services/tee`)
```
GET  /health                      → {signer, attestation, chainId, market}
GET  /attestation                 → attestation info / quote for the signer (EigenCompute)
PUT  /blobs  (body=bytes)         → {sha256}; content-addressed store; GET /blobs/<sha256>
POST /seller/upload               → seller uploads encrypted bundle + encrypted audit asset + K_bundle/K_audit wrapped to the TEE's X25519 pubkey + salts (encrypted) ; returns stored digests
POST /preview/:versionId          → runs (or returns cached) preview; returns {report, reportHash, signature}
GET  /reports/:versionId          → cached signed report
GET  /deliveries/:purchaseId      → {wrapper, wrappedKey (base64), ciphertextUrl}; only after on-chain Delivered
POST /evidence/:disputeId         → juror auth (EIP-191 signed challenge from a seated juror address) → case packet
```
Chain watcher loop: on `Purchased` → build wrapper, wrap key, sign `DeliveryReceipt`, submit
`recordDelivery`. On `DisputeOpened` with mechanical ground → rerun build/tests or reference protocol, sign `MechanicalFinding`, submit `resolveMechanical`.

## Change log
- (builders append here)
- **TEE → Phala Cloud (2026-09-11, founder decision; see "TEE — FINAL"):**
  - **Code:**
    - services/tee: `TEE_VENDOR`, dstack keys + quote attestation (`PhalaAttestor`, `EigenAttestor`
      unchanged). `@phala/dstack-sdk` 0.5.8 lives in the `services/tee/dstack` dependency island
      (its imports need `@noble` 1.x; the service uses 2.x).
    - shared: `ATTESTATION_KINDS` gains `phala-dstack-tdx`.
    - agents: log lines (for Phala, `quoteDigest` = sha256 of the quote bytes).
    - web: `/api/attestation/verify` plus a badge/panel for the new kind.
  - **Deployed:** app `4099f96ab07de8666f8a63a0f48e40aa9883eda3`, signer
    `0x51EDE7C81B66c4395AEfbdb2d626928018D393c7`, image `sha256:8afca4d8…7ad4` (commit 757a2e4).
    - The quote verifies with Phala's public verifier, the TD debug bit is off, and the OS is
      `dstack-0.5.9`.
    - A first app (`9313848a…`) got the DEV OS from the CLI's auto-selection. `update` cannot change
      the OS, so that app was deleted and replaced.
  - **Upgrade behaviour:** a PUBLIC_URL `update` changed the compose hash and kept the signer and
    X25519 key. Roles are granted by the EnvMarket owner, not by the deploy.
- **contracts (2026-09-10):**
  - *USDC address fixed.* The Base USDC address above was 39 hex digits. Corrected to
    `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle docs; on-chain `symbol()=USDC`, `decimals()=6`).
  - *Size split, still one address.* EnvMarket exceeded EIP-170, so the read-only functions live in
    `EnvMarketViews`. `EnvMarket.fallback()` delegatecalls them, and both inherit `EnvMarketStorage` as
    their first base so the storage slots match. Clients call every view on the EnvMarket address,
    using the merged ABI `packages/shared/src/abi/EnvMarket.json`. Constructor:
    `EnvMarket(IERC20 token, address viewsModule, address initialOwner, Params p)`.
  - *Pull payments (founder request).* Refunds, returned bonds, seller proceeds and juror rewards are
    credited to `claimable(address)` (event `Credited(account, amount)`) and paid out by `withdraw()`
    (event `Withdrawn`). The invariant adds `totalClaimable`:
    `balanceOf(market) == totalEscrow + totalCollateral + totalBonds + totalJurorStake + treasury + reserve + totalClaimable`.
    Owner `withdrawTreasury(to, amt)` / `withdrawReserve(to, amt)` push to `to`.
  - *Params* is a struct (`params()` view, `setParams(Params)`), field order: challengeWindow,
    deliveryWindow, refundCapBps, penaltyThresholdBps, penaltyBps, feeBps, bondFloor, bondCap, caseFee,
    participationFee, jurorStake, minoritySlashBps, nonRevealSlashBps, commitWindow, revealWindow,
    **verifierTimeout** (new, 1800 s). `setParams` requires `3 × participationFee ≤ caseFee`.
  - *Version windows.* A `VersionInput` window of 0 takes the market default. Otherwise
    `challengeWindow ≥ params.challengeWindow` (a floor) and `deliveryWindow ≤ params.deliveryWindow`
    (a cap). `taskCount` must be 1..256; `price > 0`.
  - *Collateral requirement.* `buy` requires `version.collateral ≥ caseFee + price × penaltyBps / 10000`
    (error `CollateralBelowRequirement`), so the worst-case seller-side charge is always covered.
    `caseFee` is snapshotted at purchase. Juror params (participationFee, jurorStake, slash bps,
    windows) are snapshotted at `openDispute`.
  - *Mechanical disputes.* While under review, status is `Voting`. Upheld requires
    `confirmedMask != 0 && ⊆ taskMask`; rejected requires `confirmedMask == 0`. New
    `timeoutMechanical(disputeId)`: after `verifierDeadline = openedAt + verifierTimeout`, anyone applies
    the same no-fault fallback as `FallbackNoQuorum` (bond returned, no refund, normal settlement). This
    keeps escrow from staying locked if the verifier is down.
  - *Case fee vs bond.* When a Reject verdict's bond is smaller than caseFee (demo bondFloor 5 < caseFee 6),
    the loser pays `min(caseFee, bond)`. Participation per revealer is
    `min(participationFee, pot / reveals)`; the rest of the pot plus minority slashes is split among
    majority seats, and the dust goes to the reserve.
  - *Fallback recording.* The fallback sets `verdict = Reject` and `fallbackNoQuorum = true`, and emits
    `FallbackNoQuorum(disputeId, purchaseId)`.
  - *Jurors.*
    - Reveal opens after `commitDeadline`, or as soon as all 3 seats of the round have committed.
    - Selection: a partial Fisher–Yates draw over the eligible pool, using
      `r_k = keccak256(abi.encode(seed, k))`.
    - If fewer than 3 jurors are eligible, `selectJurors` reverts `NotEnoughJurors` until
      `selectionDeadline` (arming time + commitWindow + revealWindow). After that it counts as a
      failed round (round 2, then fallback).
    - `SelectionArmed(disputeId, round, selectionBlock)` is emitted on open and on every re-arm.
    - `JurorsSelected` has a trailing `bytes32 seed`.
    - Juror registry is capped at 200 addresses. `depositJurorStake` requires approval;
      `withdrawJurorStake` allows only free (unlocked) stake.
  - *Ids.* `nextListingId / nextVersionId / nextPurchaseId / nextDisputeId` are the NEXT id to assign
    (ids start at 1).
  - *Views.* `getVersion`, `getPurchase`, `getDispute` (→ `(Dispute, Seat[6])`: seats 0–2 are round 1,
    3–5 are round 2; each seat has `juror, vote, revealed, commitment, reward, slashed`),
    `sellerStake`, `jurorInfo → (approved,total,locked,free)`, `jurorList`, `versionStats`,
    `sellerStats`, `sellerScore`, `listingVersionIds`, `listVersionIdsBySeller`,
    `listPurchaseIdsByBuyer/BySeller`, `quoteDispute(purchaseId, mask) → (requested, bond)`,
    `commitmentFor(...)`, `domainSeparator()`, `previewReportDigest`, `deliveryReceiptDigest`,
    `mechanicalFindingDigest`.
  - *Extra events.* `VersionActiveSet`, `RunnerSet/RelaySet/VerifierSet`, `ParamsUpdated`, `JurorPaid`,
    `JurorSlashed`, `RoundFailed`, `VerifierTimeout`, `TreasuryWithdrawn/ReserveWithdrawn`.
    `VersionCreated`, `Purchased` and `Delivered` carry extra trailing args (seller/price/collateral,
    relay).
  - *Deploy.* `contracts/scripts/deploy.sh [anvil|base]` takes `TOKEN_ADDR` (required off-anvil;
    TestUSDC only on 31337), `PARAM_SET=demo|mainnet` (defaults to mainnet on 8453), and
    `CONFIRM_MAINNET=yes` (required for 8453). It writes `deployments/<chainId>.json` =
    `{chainId, market, token, views, startBlock, deployer, owner, tokenSymbol, tokenDecimals, testToken, params, deployedAt, txs}`.
- **packages/shared (2026-09-10)** — conventions fixed where the spec was silent; all implemented in `@envmarket/shared`:
  - **USDC address:** an earlier revision of "Deployment target" had a malformed address (39 hex digits); the corrected `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` was verified against Circle's published list and on-chain (`symbol()`="USDC", `decimals()`=6). Exported as `BASE_USDC`, and the default token on 8453.
  - **Canonical tar:** entries sorted byte-wise by UTF-8 path (the path without its trailing slash); implied parent dirs always added; archive ends with two zero blocks (no padding to a 10240-byte record); paths over 100 bytes use the ustar `prefix` field; no PAX/GNU headers (so paths must be ASCII); symlinks and special files rejected; headers are encoded/decoded by tar-stream's ustar codec (see change log). `canonicalTarOfDir` excludes the basenames `.DS_Store`, `__pycache__`, `.pytest_cache`, `.mypy_cache` and `.git` by default (`excludeNames: []` disables this).
  - **taskHash** = sha256 of the canonical tar of `tasks/<taskId>/` with paths *relative to that directory*, so it doesn't depend on where the task lives (audit tasks hash the same way). **graderDigest** = sha256(canonical tar of `grader/`).
  - **Leaf order / taskMask:** leaves are ordered by taskId in ASCII-ascending order; bit i of `taskMask` = leaf index i. taskIds must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. The manifest's optional `taskIds` must be listed in that order.
  - **Canonical JSON:** RFC 8785 (JCS) via `canonicalize`: keys sorted by UTF-16 code units; `undefined` members omitted; bigint, NaN/Infinity, non-plain objects and lone surrogates rejected (uint256 values go in as decimal strings).
  - **Delivery wrapper:** addresses and bytes32 values are lowercase; `purchaseId`/`versionId` are decimal strings; `chainId`/`issuedAt` are JSON integers.
  - **EMENC1 / EMKW2:** EMENC1 has no AAD. EMKW2's HPKE aad is the wrapperHash; the seller→TEE upload key wrap reuses EMKW2 with HPKE info `"envmarket.upload.v1"` (`UPLOAD_KEYWRAP_INFO`), and the TEE API picks the aad (the "salt" field below).
  - **report.json:** `versionId` is a decimal string; `pass1Rounded` is an integer percent (a multiple of 5, half-up), or `null` when attempted = 0; timestamps are ISO-8601 UTC; `resolved`/`provider`/`appId`/`quoteDigest`/`verifyUrl` are nullable; the validator explanation is capped at 120 words and 1000 bytes; unknown keys are rejected. Job statuses: scheduled, running, succeeded, failed, infra_failure, superseded, cancelled.
  - **manifest.json:** strict on commitment fields (digests/roots as lowercase bytes32, counts, environmentVersion); inner shapes of the other interface-table objects are loose (so the seller's argv-style entrypoints etc. are accepted). `commercialTerms.price`/`collateral` are decimal strings in base units. `grader.digest` is optional.
  - **description.json:** `type: "envmarket.description.v1"` and/or `schemaVersion: "1"`. Each claim is `{id: "C<n>", text, category (free-form identifier), check?: string, checkable?: true}` and needs `check` or `checkable: true`.
  - **Juror evidence auth (EIP-191):** message format comes from `evidenceAuthMessage` (chainId, market, disputeId, juror, nonce, expiresAt).
  - **Config:** default `CHAIN_ID` is 8453; RPC order is `RPC_URL` > `BASE_RPC` / `BASE_SEPOLIA_RPC` / `ANVIL_RPC` > public default. `deployments/<chainId>.json` accepts `EnvMarket`|`market` and `token`|`TestUSDC`|`USDC`, plus `startBlock`. Env overrides: `MARKET_ADDRESS`, `TOKEN_ADDR`. Explorer links point to basescan.org (8453) or sepolia.basescan.org (84532); anvil gets none.
  - **LLM:** the generic OpenAI-compatible client (a thin wrapper over the official `openai` SDK) defaults to Fireworks (`FIREWORKS_API_KEY`), with `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` and per-role `_<ROLE>` overrides (Ollama supported). `resolveModels(families)` picks the newest id per family by `created`, or else by the version parsed from the id.
  - **Pinned LLM models:** shared exports `MODELS`: panel `glm-5p3` / `kimi-k3` / `qwen3p8-max`, validator `deepseek-v4-pro-0813`, jurors `deepseek-v4p1-flash` / `gpt-oss-120b` / `glm-5p2` (all under `accounts/fireworks/models/`). On Fireworks, `llmConfigFromEnv(role)` uses them as the per-role default ("validator", "juror1..3", "glm"/"kimi"/"qwen"); `LLM_MODEL_<ROLE>` overrides. `resolvePanel()` checks the pinned ids against GET /models and falls back per family. The resolver skips `accounts/fireworks/routers/*`.
  - Note: jurors commit `549c282` accidentally included the initial `packages/shared` files through the shared git index; the content is identical to what the shared builder staged.
- **services/jurors (2026-09-10):**
  - *Evidence auth.* Jurors sign shared `evidenceAuthMessage` (EIP-191; chainId, market, disputeId,
    juror, 16-byte hex nonce, expiresAt = now + 300 s) and `POST /evidence/:disputeId` with JSON body
    `{juror, message, signature, nonce, expiresAt}`. The TEE should check the signature/expiry
    (`verifyEvidenceAuth`), that the message binds this chainId/market/disputeId, and that `juror` holds a
    seat in the dispute's CURRENT round (`getDispute`, status Voting). 401/403/404 are retried until the
    commit deadline. If no evidence arrives in time the juror abstains (no commit, accepts the non-reveal
    slash) rather than guessing.
  - *Case packet.* Any JSON is accepted and passed to the model as untrusted data (≤ 4 MB; prompt copy
    truncated at 60k chars; sha256 of the exact bytes is recorded). Suggested shape
    (`envmarket.case-packet.v1`): `{disputeId, purchaseId, ground, disputedTasks, disputedClaims,
    frozenDescription:{descriptionHash, claims}, buyerStatement, buyerEvidenceHash, mechanicalFindings,
    sellerResponse}`. String leaves outside keys matching /claim|description|statement|ground|summary|title/
    are treated as private text: a public rationale copying 7+ consecutive words from them is withheld.
    The jurors add trusted on-chain facts themselves (description hash, task indices, requested refund).
  - *Registration.* The contract has no juror metadata field. Registration = owner `approveJuror`
    (allowlist; `register --self-approve-local` does it with DEPLOYER_PK on anvil only) + token approve +
    `depositJurorStake` (default 2 × jurorStake, `JUROR_STAKE` overrides). The disclosure (operator, model
    provider/requested/resolved, `sharesBaseFamilyWithReferencePanel`, prompt version + sha256, expertise,
    conflicts) is canonical JSON `envmarket.juror.v1`, stored as `.data/juror{n}-disclosure.json` and
    `PUT /blobs`; its sha256 is logged.
  - *Models.* The pinned Fireworks ids are the defaults (juror1 deepseek-v4p1-flash, juror2 gpt-oss-120b,
    juror3 glm-5p2; glm-5p2 shares the GLM family with the reference panel, which the disclosure
    flags). If a pin is not listed by `GET /models`, the fallback is the newest model of that juror's
    family, found with shared `pickNewestModels`. `JUROR{n}_MODEL` / `JUROR{n}_FAMILY` override. With no
    key and no `LLM_BASE_URL`, the jurors use local Ollama (local dev only; the first installed model to
    answer a probe; recorded as `ollama-local`).
  - *Rubric.* Prompt `services/jurors/prompts/juror-v1.md` (sha256
    `0x2477618396db15f16e13d9f73c4a2f108deb7ea59df8a26b80e14a7ce6e3bcb9`); temperature 0; strict output
    `{verdict, confidence, rationale ≤ 80 words, citedFacts 1–5 × ≤ 25 words}`, up to 3 attempts. Screening
    never changes the vote. It withholds a failing rationale ("Rationale withheld by output screening.")
    and drops failing facts.
  - *Rationale publication* happens only after the juror's own reveal is confirmed. Publishing earlier
    would leak the vote during the commit phase. Doc `envmarket.juror-rationale.v1` (canonical JSON) at
    `services/jurors/.data/rationales/<disputeId>-<juror>.json` + `PUT /blobs` on the TEE.
  - *Keeper.* Every juror calls `selectJurors` once `block.number > selectionBlock` (and again after
    `selectionDeadline` to trigger round failure), and calls `tallyDispute` once all seats have
    revealed or `revealDeadline` has passed. Expected reverts from races are ignored. Jurors reveal early
    as soon as all seats have committed. They auto-`withdraw()` after resolution
    (`JUROR_AUTO_WITHDRAW=0` disables).
- **contracts — security review (2026-09-10)** (details: `contracts/SECURITY_REVIEW.md`):
  - *Selection re-arm keeps the grace deadline.* When `blockhash(selectionBlock)` has expired,
    `selectJurors` now resets only `selectionBlock` (event `SelectionArmed`). `selectionDeadline` stays
    as first set for the round. Before this change, each re-arm pushed the deadline back, which could
    lock an unfillable dispute forever.
  - *Seat draw (supersedes the Fisher–Yates note above).* Each eligible juror draws
    `r = keccak256(abi.encode(seed, juror))`, and the 3 lowest draws are seated, in ascending order.
    The seed formula is unchanged. A juror's own eligibility no longer re-rolls the other seats.
  - *Stake age.* `depositJurorStake` records the block number. A juror whose last deposit is in a
    block after the round's `selectionBlock` is not eligible for that draw. So a juror who tops up
    while a selection is pending sits out that draw.
  - *Deposits.* `depositCollateral` and `depositJurorStake` revert with
    `SafeCastOverflowedUintDowncast(uint8,uint256)` above `uint128`. **ABI change:** this error was
    added to `packages/shared/src/abi/EnvMarket.json`. No function or event signature changed.
  - *Mainnet params* (`script/MarketParams.sol`, 8453): bondFloor 50000, bondCap 500000, caseFee 100000,
    participationFee 20000, jurorStake 250000, per the 5 USDC budget. Tested with a 0.5 USDC price and
    0.5 collateral, locally (`test/Security.t.sol`) and on a Base fork.
- **agents (2026-09-10)** — seller agent, buyer agent, e2e orchestrator (`agents/`):
  - **Purchased payload** (per the environment builder): `manifest.json`, `src/`, full `tasks/<id>/` dirs (task.json, overlay/, visible_tests/, tests/), `grader/`, `solutions/`, `requirements.lock`, `IMAGE_DIGEST`, plus `Dockerfile.runner`, `.dockerignore`, `scripts/`, `LICENSE-ENV.md`, `provenance.json`, `README.md` and `listing/` (the public docs). Never packaged: `audit-tasks/`, `SEEDED_DISPUTE.md` (lives outside py-repair-kit), `salts.json`, `keys.json`, caches. The listing promises Dockerfile.runner/scripts in delivery (claim C12), so they are part of the canonical archive.
  - **imageDigest** = the base image's registry digest from `IMAGE_DIGEST` (`base=python:3.12-slim@sha256:…`); the local runner image id is not reproducible across rebuilds. The runtime is that image plus the hash-pinned requirements.lock.
  - **descriptionHash** commits to the seller's exact `listing/description.json` bytes (not re-serialized). Packaging validates it loosely (numbered claims + environmentVersion) and records whether it also passes the shared strict schema.
  - **Manifest from template:** computed commitments are always overwritten; `taskIds` (bit i of taskMask = taskIds[i], ASCII order) is set; `<FILL…>` placeholders are either filled (bundleDigest, imageDigest, roots, license/provenance sha256, price/collateral, archive → null, harness → "EnvMarket TEE reference harness (digest in the signed report)", decoding.maxTokens → 4096) or packaging fails. Seller fields in other shapes are kept next to the derived schema fields.
  - **Seller → TEE upload:** K_bundle and K_audit wrapped (EMKW2, info "envmarket.upload.v1", HPKE aad = ciphertextHash); salts are EMENC1 under a third fresh K_salts, sent as `wrappedSaltsKey`, so K_audit is not reused. The seller checks every digest in the TEE's `stored` response and re-fetches every public doc from the blob URL by hash before listing. On-chain `uri` = the TEE's `blobBaseUrl`.
  - **Buyer evidence** is uploaded as `{base64}` to `/evidence-upload`, so the TEE stores the exact bytes and `evidenceHash = sha256(bytes)` matches on-chain.
  - **Spending limit:** purchase prices and dispute bonds both count against the persisted budget (`agents/.data/buyer/policy-<who>.json`). Refunds do not restore it.
  - **Safety rails:** agent code sends transactions only on anvil (31337) unless `ALLOW_LIVE_TX=1`. `demo/fund.ts` prints a funding plan and sends shortfalls from DEPLOYER only with `--yes`. `e2e.ts` never funds on real networks; it only checks balances. Price and collateral come from `LISTING_PRICE`/`LISTING_COLLATERAL`.
  - **Local run** (`agents/demo/local.sh`): windows are not shortened. On anvil the orchestrator advances chain time with `evm_increaseTime` (FAST_FORWARD=1) past the challenge and delivery windows. deploy.sh's shared `deployments/31337.json` is copied into the run dir (`DEPLOYMENTS_DIR`) and the shared file is restored. In local dev the TEE signs with RUNNER_PK, so that address is also granted relay and verifier. Optional `--timeout-refund`: a purchase made with an unusable (low-order) X25519 key cannot be delivered and is refunded after the delivery window.
- **services/tee** (TEE service builder):
  - **Upload wire format** (`POST /seller/upload`, JSON, binary fields base64): `encryptedBundle`, `encryptedAudit`; `wrappedBundleKey`/`wrappedAuditKey` EMKW2 to the TEE X25519 key from `/health` `encPubKey`, HPKE aad = sha256(encryptedBundle) for both, info `envmarket.upload.v1` (`envmarket.keywrap.v1` accepted); `encryptedSalts` = EMENC1(K_audit, salts.json), or EMENC1(K_salts) plus `wrappedSaltsKey`; `publicDocs` {description.json, description.md, manifest.json, license}; optional `claims`, each checked. The TEE verifies the canonical tar, bundleHash, the manifest (bundleDigest, grader digest, image ref, counts, taskIds) and both Merkle roots, then runs a sandboxed preflight.
  - **IMAGE_DIGEST parsing** follows the packager: `base=`/`ref=` names the immutable reference (bare first line also accepted).
  - **Preview gate:** `preflight.buildOk` (deps install, grader imports, hidden tests collect) is required. A reference solution that fails is reported (`preflight.ok=false`, visible to the validator), not blocking, so broken bundles can be listed and disputed.
  - **Report:**
    - Panel pinned (glm-5p3 / kimi-k3 / qwen3p8-max), checked against live `/models`.
    - `jobs[].status` is `succeeded` (graded) or `infra_failure`; it never encodes solved vs unsolved, which would leak per-task outcomes.
    - Infra failures count as attempted and not solved, and are also reported in `infraFailures`.
    - The strict schema has no disclosures field, so the provider disclosure (Fireworks sees task text) is appended to `uncertainty`. Full disclosures come with `/preview` and `/reports`.
    - `protocol.harnessDigest` = sha256 of the canonical protocol spec (served at `GET /protocol`) plus the harness source hash. It commits the reproducibility tolerances: deterministic re-grade 0, LLM re-run 5 pp per model on the masked tasks, 1 repeat.
  - **Extra endpoints:**
    - `POST /preview/:id?async=1` → 202, with `GET /reports/:id` returning 202 while running and 500 on failure. Long synchronous requests hit undici's 300 s headers timeout.
    - `POST /preview/:id/attach`.
    - `GET /protocol`.
    - `GET /findings/:disputeId`: public findings JSON, where findingsHash = sha256(canonical JSON) and it holds aggregates only.
    - `/health` also returns `encPubKey`, `keySource`, `sandbox`, `inference` and `watcher`.
  - **Evidence auth:** shared `evidenceAuthMessage`, expiry at most 1 h, single-use nonce, seated in the current round via `getDispute`. The case packet is signed EIP-191 over its sha256 and can be encrypted to a juror-supplied `encPubKey`. Evidence upload stores `{content}` as utf8, `{base64}` as raw bytes, else canonical JSON.
  - **Sandbox in the TEE:** Confidential Space containers normally lack CAP_SYS_ADMIN. So network denial there is a seccomp-BPF launcher (`runtime/netdeny.py`: no non-AF_UNIX sockets, no io_uring), with `unshare --net` added when permitted. Each phase gets its own uid via setpriv, plus prlimit. The report's `runtime.sandbox` records which mechanisms were used. On macOS the sandbox is Docker `--network none …`.
  - **Local e2e:** it runs the forge Deploy script (as deploy.sh does) but writes `services/tee/.data-e2e/deployments/31337.json`, so parallel anvil runs are not clobbered. Anvil listens on :8555.
  - **Ports:** local dev defaults to :8787 (the agents' `TEE_URL` default); the image uses PORT=8080.
  - **Storage:** EigenCompute storage is ephemeral. Private records are encrypted under a key derived from the app's stable mnemonic, but a VM replacement loses them (re-upload needed). Sealed backup is future work.
- **contracts: seller-paid previews (2026-09-10, founder requirement).** The seller pays on-chain for preview inference: the reference-model episodes and the validator, run by the EigenCompute TEE through Fireworks. Details and review: `contracts/SECURITY_REVIEW.md` (addendum, F-4).
  - **Flow:**
    1. The seller calls `GET /preview/quote/:versionId` on the TEE and gets a signed quote JSON. `quoteHash = sha256(quote JSON bytes)`.
    2. The seller approves `fee` USDC, then calls `requestPreview(versionId, fee, quoteHash)`. The fee is escrowed.
    3. The seller calls `POST /preview/:versionId`. The TEE reads `previewInfo(versionId)` and runs only if the preview is paid (`paidAt != 0`), not released, not reclaimed, has `fee ≥ quote`, and the quoteHash matches its quote.
    4. `attachReport(versionId, reportHash, runnerSig)` keeps its signature and EIP-712 type. It now requires an outstanding paid preview (otherwise `PreviewNotPaid()`), and it moves the fee from escrow to `claimable(previewFeeRecipient)`.
  - **New functions:**
    - `requestPreview(uint256 versionId, uint256 fee, bytes32 quoteHash)`: version seller only.
    - `reclaimPreviewFee(uint256 versionId)`: seller only. Allowed when no report is attached and `now > paidAt + timeout`. Credits the seller's `claimable`.
    - Owner: `setPreviewFeeRecipient(address)`, `setMinPreviewFee(uint128)`, `setPreviewTimeout(uint32)`.
    - Views (through the fallback):
      - `previewInfo(uint256) → (uint256 fee, uint256 paidAt, bytes32 quoteHash, bool released, bool reclaimed)`
      - `previewDeadline(uint256) → uint256`: reclaim needs `now >` this; 0 if never paid.
      - `previewFeeRecipient()`, `minPreviewFee()`, `previewTimeout()`, `totalPreviewFees()`.
  - **Events:**
    - `PreviewRequested(uint256 indexed versionId, address indexed seller, uint256 fee, bytes32 quoteHash)`
    - `PreviewFeeReleased(uint256 indexed versionId, address indexed recipient, uint256 fee)`, emitted by `attachReport` after `ReportAttached`
    - `PreviewFeeReclaimed(uint256 indexed versionId, address indexed seller, uint256 fee)`
    - `PreviewConfigUpdated(address recipient, uint256 minFee, uint32 timeout)`
  - **Errors:** `PreviewNotPaid()`, `PreviewAlreadyPaid()`, `PreviewFeeTooLow(uint256 fee, uint256 minFee)`. The existing errors used are `Unauthorized`, `UnknownVersion`, `ReportAlreadyAttached` and `DeadlineNotPassed`.
  - **Rules:**
    - A paid `requestPreview` must always precede `attachReport`, even when `minPreviewFee == 0`. In that case fee 0 is allowed.
    - One outstanding preview per version. A request after the report is attached reverts.
    - The recipient is read at attach time.
    - `previewTimeout` is snapshotted per request.
    - An attach after the timeout is still valid until the seller reclaims.
    - After a reclaim, the next request must pay at least the reclaimed fee. Report signatures do not bind the fee, so without this a seller could reclaim, re-request at the minimum, and attach a report the TEE already signed.
    - Raising `minPreviewFee` does not affect previews that are already paid.
    - The config lives outside `Params`. The constructor is unchanged; the defaults are recipient = initial owner, min 0, timeout 3600.
  - **Invariant:** `balanceOf(market) == totalEscrow + totalCollateral + totalBonds + totalJurorStake + treasury + reserve + totalClaimable + totalPreviewFees`.
  - **Deploy:** `PREVIEW_FEE_RECIPIENT` defaults to the deployer. That is the operator treasury that pays the Fireworks bill, not the TEE app wallet, which cannot easily withdraw. The recipient collects with `withdraw()` (pull payment). Measured preview cost is about $1.50–2.13 (`docs/PREVIEW_COST.md`), and fees of several USDC are tested. `MIN_PREVIEW_FEE` defaults to 50000 (0.05 USDC) with mainnet params and 1e6 (1 tUSDC) with demo/anvil params. `PREVIEW_TIMEOUT` defaults to 3600. `deployments/<chainId>.json` gains `preview: {feeRecipient, minFee, timeout}`.
  - **Off-chain callers must adapt:** anything that calls `attachReport` right after `createListing` now reverts `PreviewNotPaid()`. That covers the TEE `POST /preview/:id/attach`, the seller agent, and the local e2e scripts. The seller key must `requestPreview` first. The TEE should attach as soon as it signs, and should not start a run it cannot finish before `previewDeadline(versionId)`.
  - **ABI change:** `packages/shared/src/abi/EnvMarket.json` gains the functions, events and errors above. No existing signature changed.
- **services/tee** (paid previews, cost, cache):
  - **Quotes and payment:** `GET /preview/quote/:versionId` returns `{quote, quoteHash = sha256(canonical quote JSON), signature}` (EIP-191 over the raw hash). The quote has a 15-minute `validUntil`. Before running, the TEE requires `previewInfo(versionId)` to be:
    - paid, not released and not reclaimed;
    - carrying a `quoteHash` issued by this service for this version;
    - `fee >= quote.feeUsdc`, and paid before `validUntil`.

    It also requires the estimated run to fit before `previewDeadline`. Otherwise it returns 402 (409 for the deadline). It attaches right after signing.
  - **Cost model:** constants from docs/PREVIEW_COST.md live in `services/tee/src/cost.ts`. `quote = ceilToCent(episodeCost×1.5 + validatorCost)`, and a cached run's fee is `minPreviewFee`. The harness enforces the per-model `fullBudgetIn/Out` token bound, so `worstCase` is a real bound; a stopped episode counts as failed. The harness records actual usage and USD per episode and for the validator. `inferenceCostUsd`/`feePaidUsdc` go into report.json only once shared's strict schema accepts them; `/preview` and `/reports` return them already.
  - **Preview cache** (founder request): a run is keyed by `(bundleHash, auditRoot, protocolId, harnessDigest, promptDigest, validatorPromptHash, panel ids, validator id)` and not by versionId, market or chain. It is stored encrypted and signed. A new version with the same key gets a freshly signed report with the original jobs, dates and scores, plus `cachedFrom {originalRunAt, originalVersionId, originalChainId}`; until shared's schema has that field, a disclosure note goes in `uncertainty` instead. A reused local-dev run keeps `attestation.kind = none-local-dev`, and runs with infra failures are never cached. The export tool is `scripts/export-preview-cache.ts`: entries are sealed to the target's X25519 key and accepted only from `PREVIEW_CACHE_TRUSTED_SIGNERS`, via `POST /preview-cache/import` or `PREVIEW_CACHE_IMPORT_DIR` at startup.
  - **Validator model:** Fireworks lists `deepseek-v4-pro` but returns 404 (not deployed). Resolution probes candidates in order: pinned id, its dated snapshots (`deepseek-v4-pro-0813`), the newest serving DeepSeek, then gpt-oss. Any substitution is disclosed in `uncertainty`.
  - **In-TEE sandbox fixes:** spawn with a fixed PATH (`/usr/local/bin` python). Read-only grants are root-owned with group = the phase uid (`u=rwX,g=rX,o=`), so graders' `shutil.copytree` copies stay writable while other episodes are locked out. Verified in the linux image, where seccomp net-deny is the path (no CAP_SYS_ADMIN).
- **services/tee** (all-testnet decision): the EigenCompute environment is config-driven through `EIGEN_ENVIRONMENT`, default `sepolia`. It selects the verify dashboard (verify-sepolia.eigencloud.xyz), the AppController (`0x0dd810a6ffba6a9820a10d97b659f07d8d23d4E2` on Ethereum Sepolia) and the control chain. All three are exposed in `/attestation`, and no `mainnet-alpha` value is hardcoded. The TEE's sealed env sets `CHAIN_ID=84532` and `BASE_SEPOLIA_RPC` (read through shared config). The README deploy steps use `--environment sepolia`.
- **agents (2026-09-11)** — seller-paid previews and the testnet target:
  - **Preview fee:** `payPreview` (called by `seller preview` and e2e, or standalone as `seller pay-preview`) fetches `GET /preview/quote/:versionId`. It checks `sha256(canonicalJson(quote)) == quoteHash`, the EIP-191 signature by `quote.signer`, `isRunner(signer)` on-chain, the chainId/market/versionId/bundleHash binding, and `validUntil`. It then approves exactly and calls `requestPreview(versionId, max(quote.feeUsdc, floor), quoteHash)`. The floor is `minPreviewFee()`, or the reclaimed fee after a reclaim. If the TEE has no quote endpoint (404), it pays `minPreviewFee()` with quoteHash 0; that fallback is isolated in this one function. It is idempotent while a paid request is outstanding. After `POST /preview`, the seller waits for the TEE's own `attachTx`. A lost attach race counts as success when the hash on-chain equals the verified one. The preview-fee recipient withdraws released fees with `seller ops-withdraw` or `keeper --ops`.
  - **Collateral:** the e2e tops the seller's available stake up to one sale's collateral before each purchase, because an upheld dispute slashes caseFee + penalty from the stake. Listing collateral is raised to the contract floor (`caseFee + price·penaltyBps`) if configured below it.
  - **Chains:** agents transact by default on anvil (31337) and Base Sepolia (84532). Any other chain needs `ALLOW_LIVE_TX=1`. `demo/fund.ts` plans per actor: gas ETH from DEPLOYER (anvil: `anvil_setBalance`), then TestUSDC by `mint` if DEPLOYER owns the token, else the actor's own `faucet()` when `faucetAvailableAt` has passed, else a transfer. It sends only with `--yes`. Demo-sized targets apply when the token is TestUSDC (seller 500, buyer 200, buyer2 250, jurors 50, 0.002 ETH on 84532). e2e defaults to 100/100 tUSDC terms with TestUSDC.
  - **Local e2e isolation:** local.sh accepts `TEE_DIR`. It kills whole process trees on exit (npx/tsx leave nested node processes) and refuses to start if its TEE port already answers. Because builders share one working tree, the final e2e runs from a `git archive HEAD` snapshot under `agents/.data/e2e-snapshot/` (node_modules copied so `@envmarket/shared` resolves inside the snapshot). One reason: a process that loads shared's tar/commitment code while another builder is mid-edit computes different task hashes, and the TEE then rightly rejects the upload's taskRoot.
- **packages/shared: established libraries instead of hand-rolled code (2026-09-11, founder directive).** Exported names and signatures are unchanged (tee, jurors and agents pass unmodified); wire formats changed where noted. Nothing deployed depends on the old formats, but listings packaged or wrapped before this change must be re-packaged / re-wrapped.
  - **Key wrap: EMKW1 (custom ECIES) → EMKW2 = HPKE, RFC 9180.** Blob = `"EMKW2"` ‖ enc (32) ‖ ciphertext (32-byte key ‖ 16-byte tag) = 85 bytes (was 97). mode_base, suite DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM (0x0020/0x0001/0x0002); `info` = `"envmarket.keywrap.v1"` (uploads `"envmarket.upload.v1"`); `aad` = the wrapperHash bytes (uploads: sha256(encryptedBundle); the value the TEE API used to call the "HKDF salt" is now the HPKE aad). No transmitted nonce: HPKE derives it, and a fixed ephemeral key still gives a deterministic blob (relay re-derivation; the old `nonce` arg is accepted and ignored). Buyer keys stay raw 32-byte X25519 (`bytes32`), which is RFC 9180's serialization, and `@hpke` imports them directly (`deserializePrivateKey`/`deserializePublicKey`).
    - Implementation: `@hpke/core` 1.9.0 + `@hpke/dhkem-x25519` 1.8.0 only. `wrapKey` / `unwrapKey` are **async** (Promise) and `wrapKeyAsync` / `unwrapKeyAsync` are aliases of them; `hpkeSuite()` exposes the suite.
    - No custom crypto (founder decision, 2026-09-11): the interim synchronous `wrapKey`/`unwrapKey` shim (an RFC 9180 key schedule over @noble primitives, `hpkeSealBase`/`hpkeOpenBase`) is deleted. Every caller now awaits the @hpke/core functions: services/tee, agents (`verifyDelivery` is now async), the services/jurors integration script, and the apps/web purchase page. Tests run the CFRG RFC 9180 test vector for this exact suite through @hpke/core and interoperate with pyhpke 0.6.5 in both directions (Python; set `HPKE_PYTHON=<python with pyhpke>`).
    - `deriveKek` is removed; `parseWrappedKey` returns `{enc, ephemeralPublicKey, ciphertext}`.
    - apps/web: `unwrapBundleKeyAsync` (@hpke/core) is the only unwrap. The sync `unwrapBundleKey` is removed. `packages/shared/test/web-crypto.test.ts` checks it against shared's `wrapKey`.
  - **EMENC1:** format unchanged; now node:crypto (OpenSSL) AES-256-GCM instead of @noble/ciphers, cross-checked against WebCrypto.
  - **Canonical JSON = RFC 8785 (JCS)** via `canonicalize` 5.0.0, the reference implementation by the RFC's authors (apps/web too). Our pre-checks still reject bigint, NaN/Infinity, non-plain objects and `undefined` in arrays. Output is byte-identical to the previous encoder for every committed JSON document in seller-workspace and for delivery wrappers (tested). The only behavioural difference is that strings with lone surrogates are now rejected. Report, wrapper, description, manifest and quote hashes are unchanged.
  - **Merkle: `@openzeppelin/merkle-tree` 1.0.8 `SimpleMerkleTree`** (`sortLeaves: false`, so leaves stay in taskId order and index == taskMask bit). Same sorted-pair keccak (OZ `commutativeKeccak256`), and proofs verify with `MerkleProof.verify`. OZ's complete-tree layout gives the same roots as the old promote-the-odd-node tree for 1–4, 6 and 8 leaves, but different roots for others. For 5 leaves: root = H(H(H(l0,l1), l4), H(l2,l3)), not H(H(H(l0,l1), H(l2,l3)), l4). py-repair-kit's 5-task root therefore changes. `merkleLayers` is removed and `merkleTree(leaves)` added. Roots for 4, 5 and 7 leaves are pinned in tests.
  - **Tar:** headers are serialized and parsed by tar-stream 3.2.1's ustar codec (`headers.js`, pinned to that exact version). It is loaded by file path, because tar-stream's package exports only its async pack()/extract() streams and our API is synchronous. Our framing, sorting, normalization (mtime 0, uid/gid 0, fixed modes) and extraction safety checks stay. `writeTar` output is byte-identical to tar-stream `pack()` (tested) and readable by its `extract()`, system tar and Python tarfile.
    - Byte differences from the hand-rolled writer: numeric fields are 6 octal digits + space + NUL (was 7 digits + NUL), and long paths are split into `prefix` at the first `/` that leaves a name of at most 100 bytes.
    - New restrictions: non-ASCII paths are rejected, since plain ustar can't hold them without PAX, and GNU-magic headers are rejected on read.
    - All canonical bundle hashes, taskHashes and graderDigests change. The new vector is pinned in `test/tar.test.ts`.
  - **LLM client:** `LlmClient` is now a thin wrapper over the official `openai` SDK 7.15.0 (`baseURL` Fireworks by default, or Ollama), with the same `chat` / `listModels` / `jsonSchemaResponse` / `runToolLoop` API. It still records the served model id, generation id, usage and attempt count.
    - Retries and backoff (including Retry-After) and timeouts come from the SDK: `retries` → `maxRetries`, default 2; `timeoutMs` → per-attempt `timeout`, default 180 s.
    - The API key is always passed explicitly (keyless endpoints get a dummy bearer), and `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_ADMIN_KEY` from the env are never forwarded. A 200 response whose body carries `error` is no longer retried.
  - **Validator model:** `MODELS.validator` = `accounts/fireworks/models/deepseek-v4-pro-0813`. The undated `deepseek-v4-pro` is listed by GET /models but returns 404 "not deployed" on serverless chat. A new live test sends a real 1-token completion to every pinned model (panel, validator, jurors), so a listed-but-unserved id fails `npm test`.
  - **Misc:** `.env` parsing uses `dotenv` 17; `concatBytes` / `equalBytes` come from @noble; `@noble/ciphers` is dropped from shared.
- **harness (2026-09-11)** — `harness/envmarket_coding`, an open-source reference harness built on Prime Intellect `verifiers` 0.3.1 (MIT; classic `vf.MultiTurnEnv` + `vf.Rubric`). It replaces the TypeScript tool loop for preview runs and PreviewNotReproducible re-runs. Contract: `harness/README.md`.
  - *Manifest (additive):* `schemas["action.jsonSchema"]` is a JSON Schema `oneOf` with one branch per action, discriminated by `type`, plus `x-terminal` / `x-countsAgainstBudget`. It is added to both seller templates (py-repair-kit, humanevalfix-8). The harness generates its tools from it (tool name = the `type` const). The loose `schemas.action` stays for humans and older bundles (the harness falls back to it). `listing/` is in the payload, so these bundles' bundleDigest changes: re-package.
  - *CLI:* `python -m envmarket_coding.run` writes one JSON line per episode, then a summary per model. The record includes score, termination, usage, costUsd, served model, grade, finalFiles and transcriptHash. `--digest` prints harnessDigest: the canonical tar of `harness/envmarket_coding` (source + uv.lock + requirements.lock), in the same ustar form as shared `tar.ts`, excluding `.venv`/`.ruff_cache`. It also prints promptDigest and toolsDigest. `--regrade` re-grades stored finalFiles (tolerance 0).
  - *Grading isolation:* hidden tests run in a separate sandboxed process (`entrypoints.gradeArtifact`), never through `serve`'s `grade`. Agent-written code runs inside the serve sandbox during visible tests, and there it must not reach hidden tests.
  - *Sandboxes:* `--sandbox docker|unshare|none` uses the same flags as `services/tee/src/sandbox.ts`. `unshare` uses a network namespace when the kernel allows it, otherwise the TEE's seccomp launcher via `--netdeny`, and refuses to run with neither. It has no mount namespace, so it also refuses to run when the bundle or audit dir is reachable by other uids (every ancestor `o+x`). Read-only grants are root-owned with group = the phase uid, and the final workspace is copied for the grading uid. Both unshare variants were verified in a linux container (uid 40001, sockets denied, hidden tests unreachable).
- **services/tee** (open-source harness, async HPKE):
  - **The harness now runs every episode.** Preview episodes and the PreviewNotReproducible re-run and re-grade go through `harness/envmarket_coding` (Prime Intellect verifiers 0.3.1), called as a subprocess (`--digest`, run, `--regrade`) per harness/README.md. The TypeScript tool loop (`services/tee/src/harness.ts`) has been deleted.
  - **Record mapping:** records map onto the stored `EpisodeResult`, keyed TEE-side by (model, split, task). A missing record or a non-zero exit becomes an infra failure. Plaintext `--out` and transcripts are read back into the encrypted store and deleted.
  - **Protocol id** becomes `envmarket.preview.v2`.
  - **Report binding:** `report.protocol.harnessDigest` = sha256 of a published commitment (blob `/blobs/<digest>`) over {spec including the harness `harnessDigest` source hash, harness `protocol`, decoding, tolerances, and the bundle's `toolsDigest`}. `protocol.promptDigest` is the harness `promptDigest`.
  - **Image:** the Docker image ships the harness in `/opt/harness-venv`, installed from its hash-pinned requirements.lock (`HARNESS_DIR`, `HARNESS_PYTHON`).
  - **Gap:** the harness has no cumulative per-episode token stop (only `max_tokens` per call plus its call cap). The docs/PREVIEW_COST.md `fullBudgetIn/Out` bound is therefore not enforced, and quotes carry `tokenBoundEnforced: false`. Adding it needs a harness flag.
  - **Key wrap:** every key wrap uses shared `wrapKeyAsync`/`unwrapKeyAsync` (@hpke/core, EMKW2). The relay's stored ephemeral key still re-derives the delivered blob byte-for-byte (`ekm`).
- **services/tee + harness** (token bound now enforced; supersedes the "Gap" note above):
  - **Harness flag.** `harness/envmarket_coding` gained `--max-episode-tokens` (`N` | `IN:OUT` | `MODEL=IN:OUT`, repeatable). Before every model call it checks cumulative prompt tokens plus the exact next prompt (estimated at 3 chars/token) against the input cap, and caps `max_tokens` at the remaining output cap. A call with fewer than 256 output tokens left is not started. The episode then ends with `termination: "token_budget"` and score 0; it is not an infra failure, and the record carries `tokenBudgetExhausted` and `tokenCaps`.
  - **TEE.** It passes docs/PREVIEW_COST.md `fullBudgetIn:fullBudgetOut` per panel model, maps `token_budget` to `tokenBudgetExceeded`, and quotes now say `tokenBoundEnforced: true`, so `worstCaseUsd` is a bound up to the next-prompt estimate. Verified live on Fireworks: a capped Kimi K3 episode stopped with `token_budget` and no infra failure.
  - **Validator screening.** Path-derived identifiers now come only from task/solution/audit paths; bundle metadata names such as `IMAGE_DIGEST` are not treated as secrets.
- **packages/shared report schema + services/tee (2026-09-11):** `reportSchema` gains optional `cachedFrom {originalRunAt, originalVersionId, originalChainId}`, `inferenceCostUsd`, `feePaidUsdc`, `protocol.toolsDigest` and `protocol.tokenBoundEnforced` (strict objects, so typos fail; older reports still parse). The TEE writes them directly and no longer appends the cache-reuse note to `uncertainty`; the web `checkReportSchema` mirror accepts them.
- **services/jurors-vercel (2026-09-11): jurors run on Vercel, not on a laptop** (founder direction). The Vercel project `rl-env-market-jurors` (Hobby plan) runs the three jurors as Vercel Functions plus Vercel Workflow. There is one durable workflow run per FalseDescription dispute, and the run sleeps between chain deadlines. `services/jurors` stays as the reference implementation and local/anvil runner. The Vercel service vendors its modules byte for byte (`scripts/sync-vendor.mjs --check` runs in `npm test` and the deploy script): prompt `juror-v1` (same sha256), case-packet fetch with the same EIP-191 auth, verdict parsing, screening, `commitmentOf`, rationale doc and `POST /rationales`, and the model pins.
  - *Trigger.* `POST /api/wake {disputeId?}` is idempotent, CORS-allowed for the web origin, and rate limited. It reads `nextDisputeId` and `getDispute` for the most recent 200 ids, which replaces a DisputeOpened log scan: same result, no getLogs range limits. It starts a run for each unresolved FalseDescription dispute that has none. With nothing pending it returns "nothing to do". Callers: the web app right after `openDispute` (fire-and-forget), the buyer CLI after `dispute`, and a daily Vercel Cron `/api/cron/sweep` as a safety net (Hobby crons run at most daily).
  - *Lock.* A deterministic hook token `envmarket-jurors:<chainId>:<market>:<disputeId>` plus `hook.getConflict()` ensures a second concurrent run for the same dispute exits.
  - *Loop.* Each iteration reads a chain snapshot, runs a pure planner, then executes steps. The keeper `selectJurors` fires once block > selectionBlock, and after `NotEnoughJurors` it retries at selectionDeadline so the round can fail over. The three seated jurors deliberate in parallel, each cut off about 12 s before commitDeadline and within the 300 s function limit. Then `prepareVote`, then `commitVote`. `revealVote` follows once all three committed or after commitDeadline. `POST /rationales` runs after the reveal is on-chain. The keeper `tallyDispute` fires once all revealed or after revealDeadline. The same loop handles round 2. On resolution each juror withdraws, and the run ends.
  - *Vote salts are derived, not stored* (supersedes "salt persisted to disk before commitVote" for this service): `salt = HMAC-SHA256(juror key, "envmarket.juror-vote-salt.v1|chainId|market|disputeId|round|juror")`. It is unpredictable without the key, and any later run recomputes it, whether after a crash, redeploy or lost run. The reveal step recovers the verdict by matching the on-chain commitment against both verdicts. Verdict and commitment are recorded in the `prepareVote` step result, in the workflow event log, before the commit tx. The salt is never logged or persisted. Commitment encoding is cross-checked against `cast` in tests.
  - *Nonces.* One juror key per step, one tx per key at a time within a run, and every tx waits for its receipt. Each tx step re-reads the seat first, so there is never a second commit. Collisions across concurrent runs return "not applied", and the loop retries.
  - *Keys and switch.* `JUROR1..3_PK`, `FIREWORKS_API_KEY` and `CRON_SECRET` are Vercel sensitive env vars (production) in this project only. The public web project never holds them. `JURORS_ENABLED=1` is required to send any tx; otherwise wake is a dry run.
  - *Hobby limits used.* Workflow 50k events/month and 1-day run retention; `sleep` and run duration unlimited; functions 300 s.
