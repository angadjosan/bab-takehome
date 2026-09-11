# Build Spec — RL Environment Market (implementation contract for all builders)

This is the implementation contract for `docs/RL_ENV_MARKET.md`. Every builder must follow the
interfaces here exactly so parallel work integrates. If you must deviate, record the change in
the "Change log" at the bottom of this file in the same commit.

**Hard rule from the founder: nothing is mocked.** Testnet (Base Sepolia, a test ERC-20 standing in
for USDC) is fine, but every component must really work: real TEE deployment + attestation on
EigenLayer (EigenCompute), real LLM inference for reference runs / validator / jurors, real
on-chain randomness for juror selection, real encryption and delivery, real disputes and
settlement. A local dev mode is allowed (e.g. running the TEE service on a laptop for tests), but
it must be labeled truthfully in reports (`attestation.kind = "none-local-dev"`) and is never the
demo path.

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
  Validator: `accounts/fireworks/models/deepseek-v4-pro`. Jurors (diverse, disclose shared bases):
  juror1 `accounts/fireworks/models/deepseek-v4p1-flash`, juror2 `accounts/fireworks/models/gpt-oss-120b`,
  juror3 `accounts/fireworks/models/glm-5p2`.
- Env names: `BASE_RPC=https://mainnet.base.org`, `CHAIN_ID=8453`. Local tests: anvil 31337.

Mainnet params (override the demo table below on 8453): price 2 USDC, collateral 2 USDC per sale,
bondFloor 0.25, bondCap 2, caseFee 0.30, participationFee 0.05, jurorStake 1 USDC, other bps/
windows unchanged (challenge 300 s, delivery 600 s, commit/reveal 180 s each).

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
**Merkle root**: OpenZeppelin-style sorted-pair keccak256 tree over leaves (odd leaf promoted).
`auditRoot` built the same way over audit tasks with domain `"envmarket.audit.v1"`.

**Encryption**: AES-256-GCM. File format `"EMENC1"` (6 bytes) ‖ nonce (12) ‖ ciphertext ‖ tag (16).
Bundle key `K_bundle` and audit key `K_audit` are independent random 32-byte keys.

**Delivery wrapper** (buyer-specific, around the unchanged ciphertext): canonical JSON (sorted keys,
no whitespace) `{"type":"envmarket.delivery.v1","purchaseId":"..","chainId":..,"market":"0x..","buyer":"0x..","buyerEncPubKey":"0x..","versionId":"..","bundleHash":"0x..","ciphertextHash":"0x..","issuedAt":<unix>,"relay":"0x.."}`.
`wrapperHash = sha256(wrapperJSON)`.

**Wrapped key** (ECIES, X25519): relay makes ephemeral X25519 keypair; `shared = X25519(eph_sk, buyerEncPubKey)`;
`kek = HKDF-SHA256(ikm=shared, salt=wrapperHash bytes, info="envmarket.keywrap.v1", 32)`;
blob = `"EMKW1"` ‖ eph_pk (32) ‖ nonce (12) ‖ AES-GCM(kek, K_bundle) ‖ tag. `wrappedKeyHash = sha256(blob)`.
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
  - **Canonical tar:** entries sorted byte-wise by UTF-8 path (the path without its trailing slash); implied parent dirs always added; archive ends with two zero blocks (no padding to a 10240-byte record); paths over 100 bytes use the ustar `prefix` field; no PAX/GNU headers; symlinks and special files rejected. `canonicalTarOfDir` excludes the basenames `.DS_Store`, `__pycache__`, `.pytest_cache`, `.mypy_cache` and `.git` by default (`excludeNames: []` disables this).
  - **taskHash** = sha256 of the canonical tar of `tasks/<taskId>/` with paths *relative to that directory*, so it doesn't depend on where the task lives (audit tasks hash the same way). **graderDigest** = sha256(canonical tar of `grader/`).
  - **Leaf order / taskMask:** leaves are ordered by taskId in ASCII-ascending order; bit i of `taskMask` = leaf index i. taskIds must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. The manifest's optional `taskIds` must be listed in that order.
  - **Canonical JSON:** keys sorted by UTF-16 code units; `undefined` members omitted; bigint, NaN/Infinity and non-plain objects rejected (uint256 values go in as decimal strings).
  - **Delivery wrapper:** addresses and bytes32 values are lowercase; `purchaseId`/`versionId` are decimal strings; `chainId`/`issuedAt` are JSON integers.
  - **EMENC1 / EMKW1:** no AAD. The seller→TEE upload key wrap reuses EMKW1 with HKDF info `"envmarket.upload.v1"` (`UPLOAD_KEYWRAP_INFO`); the TEE API picks the salt.
  - **report.json:** `versionId` is a decimal string; `pass1Rounded` is an integer percent (a multiple of 5, half-up), or `null` when attempted = 0; timestamps are ISO-8601 UTC; `resolved`/`provider`/`appId`/`quoteDigest`/`verifyUrl` are nullable; the validator explanation is capped at 120 words and 1000 bytes; unknown keys are rejected. Job statuses: scheduled, running, succeeded, failed, infra_failure, superseded, cancelled.
  - **manifest.json:** strict on commitment fields (digests/roots as lowercase bytes32, counts, environmentVersion); inner shapes of the other interface-table objects are loose (so the seller's argv-style entrypoints etc. are accepted). `commercialTerms.price`/`collateral` are decimal strings in base units. `grader.digest` is optional.
  - **description.json:** `type: "envmarket.description.v1"` and/or `schemaVersion: "1"`. Each claim is `{id: "C<n>", text, category (free-form identifier), check?: string, checkable?: true}` and needs `check` or `checkable: true`.
  - **Juror evidence auth (EIP-191):** message format comes from `evidenceAuthMessage` (chainId, market, disputeId, juror, nonce, expiresAt).
  - **Config:** default `CHAIN_ID` is 8453; RPC order is `RPC_URL` > `BASE_RPC` / `BASE_SEPOLIA_RPC` / `ANVIL_RPC` > public default. `deployments/<chainId>.json` accepts `EnvMarket`|`market` and `token`|`TestUSDC`|`USDC`, plus `startBlock`. Env overrides: `MARKET_ADDRESS`, `TOKEN_ADDR`. Explorer links point to basescan.org (8453) or sepolia.basescan.org (84532); anvil gets none.
  - **LLM:** the generic OpenAI-compatible client defaults to Fireworks (`FIREWORKS_API_KEY`), with `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` and per-role `_<ROLE>` overrides (Ollama supported). `resolveModels(families)` picks the newest id per family by `created`, or else by the version parsed from the id.
  - **Pinned LLM models:** shared exports `MODELS`: panel `glm-5p3` / `kimi-k3` / `qwen3p8-max`, validator `deepseek-v4-pro`, jurors `deepseek-v4p1-flash` / `gpt-oss-120b` / `glm-5p2` (all under `accounts/fireworks/models/`). On Fireworks, `llmConfigFromEnv(role)` uses them as the per-role default ("validator", "juror1..3", "glm"/"kimi"/"qwen"); `LLM_MODEL_<ROLE>` overrides. `resolvePanel()` checks the pinned ids against GET /models and falls back per family. The resolver skips `accounts/fireworks/routers/*`.
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
