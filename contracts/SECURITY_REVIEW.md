# EnvMarket security review (2026-09-10)

Scope: `src/EnvMarket.sol`, `src/EnvMarketStorage.sol`, `src/EnvMarketViews.sol` (served through
`EnvMarket.fallback()` by delegatecall), `src/TestUSDC.sol`. Target: Base mainnet with native USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), small amounts. Checked against `docs/BUILD_SPEC.md`
(contract section and change log) and `docs/RL_ENV_MARKET.md` (invariants, refund rules, juror procedure).
Regression tests for every finding are in `test/Security.t.sol`.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| F-1 | Medium | Re-arming an expired selection block pushed back the grace deadline, so an unfillable panel could lock escrow forever | Fixed |
| F-2 | Low | A juror could re-roll the whole panel by toggling their own eligibility, or opt in after the seed was public | Fixed |
| F-3 | Informational | Deposits above `uint128` were silently truncated | Fixed |

### F-1 (Medium): re-arm extended the selection grace period, which could lock escrow permanently

If `blockhash(selectionBlock)` had expired (more than 256 blocks old), `selectJurors` called
`_armSelection`. That reset `selectionBlock`, but it also reset `selectionDeadline = now + commitWindow + revealWindow`.
When fewer than 3 jurors are eligible, the round is only failed once `now > selectionDeadline`, and
only by a call made while the blockhash is still live. If `commitWindow + revealWindow` is longer
than 256 blocks of wall time (512 s on Base), every call does one of two things:

- If the blockhash is still live, the deadline has not passed yet, so the call reverts with `NotEnoughJurors`.
- If the blockhash has expired, the call re-arms and moves the deadline forward again.

The dispute never reaches round 2 or the fallback. The buyer's price, the bond and the seller's
collateral stay locked forever. The mainnet params (180 + 180 s) leave only a narrow working window
(360 to 512 s after arming). Longer production windows, or a shorter Base block time, turn this
into a permanent lock.

**Fix:** the expired-blockhash branch now resets only `selectionBlock` and emits `SelectionArmed`. The
grace deadline for the round stays where it was first set. Test: `testRearmDoesNotExtendSelectionGrace`
(2 h grace, 13 re-arms, then the round fails over and the dispute falls back).

### F-2 (Low): panel re-roll and late opt-in by jurors

The seed (`blockhash(selectionBlock)` plus `prevrandao`, which on OP-stack chains is the L1 origin's
value and known ahead of time) is public one block before `selectJurors` can land. Panel selection
was a Fisher–Yates draw over the eligible pool in registry order. So any approved juror could
withdraw or deposit stake, or time a `tallyDispute` that frees their locked stake, just before
selection. That shifted every pool index and re-rolled the whole panel. A juror could also deposit
only when they could see they would be seated.

**Fix:**
- Each eligible juror now draws `r = keccak256(abi.encode(seed, juror))`, and the 3 lowest draws are
  seated. A seat depends only on that juror's own draw. The most a juror can do is remove
  themself, and the next-ranked juror takes the seat.
- A new `JurorInfo.stakeBlock` records the block of the last `depositJurorStake`. Stake deposited
  after the round's `selectionBlock` does not count for that draw. A deposit in the selection block
  itself still counts, because the hash is not known yet.

Side effect: a juror who tops up while a draw is pending sits out that draw. Tests:
`testNonSeatedJurorCannotRerollPanel`, `testSeatedJurorLeavingOnlyReplacesThemself`,
`testStakeAddedAfterSelectionBlockIsIneligible`, `testStakeAtOrBeforeSelectionBlockIsEligible`.

### F-3 (Informational): uint128 truncation on deposits

`depositCollateral` and `depositJurorStake` did `total += uint128(amount)` while pulling and counting
the full `amount`. Only the depositor would lose, and USDC's supply is far below 2^128. But it broke
the bucket accounting (`totalCollateral` / `totalJurorStake` against the per-account totals).
**Fix:** `SafeCast.toUint128`. This adds the error `SafeCastOverflowedUintDowncast(uint8,uint256)`
to the ABI. Test: `testDepositsAboveUint128Revert`.

## Reviewed with no issue found

- **Fund conservation.** Every token in-flow and out-flow maps to exactly one bucket. Every internal
  move debits one bucket and credits another for the same amount: refund/fee/proceeds split, case
  fee, penalty, bond forfeit, juror participation/bonus/slash, and dust into the reserve. The payout
  caps are covered by collateral: `buy` requires `collateral ≥ caseFee + price·penaltyBps` against
  the snapshotted values, and `_resolve` clamps both charges to `collateral`. Seller
  `total ≥ reserved` and juror `total ≥ locked` hold, because each seat or purchase releases its
  own lock in the same step as its own slash. Invariant tests cover this, plus
  `_checkConservation` in every flow.
- **Double settlement and reentrancy.** Every settle path is gated by a state
  (`Funded` / `Delivered` / `Disputed`, and `DisputeStatus.Voting` / `AwaitingSelection`), and is
  set to `Settled` / `Resolved` before any credit. Settlement never transfers tokens: it only
  credits `claimable`, which is paid by `withdraw()`. Every external token call comes after its
  state writes (checks-effects-interactions), so even a future USDC hook could not re-enter for profit.
- **Fallback / delegatecall.**
  - Storage layouts match slot for slot (0–32, checked with `forge inspect … storageLayout`).
    EnvMarket's extra slots 33–35 (the EIP712 fallback strings and `_owner`) come after the
    shared layout.
  - `EnvMarketViews` has no SSTORE, selfdestruct or delegatecall.
  - Shared selectors (public getters declared in `EnvMarketStorage`) resolve in EnvMarket's own
    dispatcher first. No state-changing EnvMarket function is shadowed.
  - Unknown selectors revert. The fallback is non-payable (`testFallbackRejectsUnknownSelectors`).
- **EIP-712.**
  - The domain binds chainId and the contract address (`testSignatureNotReplayableAcrossDeployments`).
  - `PreviewReport` binds versionId + bundleHash, and a version's terms are immutable after creation.
  - `DeliveryReceipt`'s digest is rebuilt on-chain from the purchase's `buyerEncPubKey`, and
    `ciphertextHash` must equal the version's.
  - `MechanicalFinding` binds disputeId, and each dispute id maps to one purchase and one ground.
  - OZ 5.6.1 `tryRecover` accepts only 65-byte signatures with low s (`testMalleatedSignatureRejected`).
  - Each signed action is single-shot by state, so a signature cannot be reused.
- **Access control.** Owner-only for params, roles, the juror allowlist, and treasury/reserve
  withdrawals. The owner has no path to escrow, collateral, bonds, juror stakes or `claimable`.
- **Snapshots.**
  - At purchase: fee, refund cap, penalty, bond floor/cap, caseFee, windows, taskCount.
  - At openDispute: juror params and verifier timeout.
  - `setParams` cannot change terms for a purchase or dispute that already exists.
- **Commit-reveal.**
  - The commitment binds disputeId, round, verdict, salt and juror, so a copied commitment cannot be
    revealed by the copier (`testCopiedCommitmentCannotBeRevealed`).
  - Commits are allowed only while `now ≤ commitDeadline`. Reveals are allowed after
    `commitDeadline`, or once all seats have committed, until `revealDeadline`. Tally is allowed
    after `revealDeadline`, or once all seats have revealed. These boundaries are consistent.
  - Round 2 excludes round-1 jurors. The pool has no duplicates, so a juror holds at most one seat.
- **Deadlines.** `recordDelivery ≤ deliveryDeadline < refundUndelivered` and
  `openDispute ≤ challengeDeadline < finalize`. Each boundary has exactly one valid action.
- **Liveness.** Every non-terminal state has a permissionless exit:
  - `refundUndelivered`, `finalize`, `timeoutMechanical`.
  - `selectJurors`, which after F-1 always ends with a panel, round 2, or the fallback.
  - `tallyDispute`.
- **Rounding at the mainnet params** (price 0.5, collateral 0.5, 5 tasks, bondFloor 0.05, bondCap 0.5,
  caseFee 0.10, participationFee 0.02, jurorStake 0.25):
  - Collateral requirement: 0.15 ≤ 0.5.
  - perTask = 0.1, refund cap = 0.25.
  - Juror pot 0.10 ≥ 3 × 0.02.
  - No division by zero: taskCount ≥ 1, reveals ≥ 2, and the majority count is ≥ 1.
  - Floor dust stays with the seller (perTask) or goes to the reserve (bonus split).
  - Tests: `testMainnetParams*` and the Base fork suite.

## Residual risks (not fixed in code)

1. **Randomness on Base.** `prevrandao` on OP-stack chains is the L1 origin's RANDAO, which is
   known in advance. The sequencer orders transactions and produces blockhashes. If no keeper calls
   `selectJurors` right after `selectionBlock`, the first caller can choose among about 40 seeds
   within the 256-block window. Mitigation today: every juror process runs a keeper that calls at
   `selectionBlock + 1`. For production, use a VRF or a commit-reveal beacon.
2. **Thin juror pool.**
   - With 3 registered jurors, round 2 can never be filled, because round-1 jurors are excluded.
     So any failed round ends in `FallbackNoQuorum`: no refund, and the seller is paid.
   - With 0.3 USDC each (spec funding plan), each juror covers only one 0.25 seat. A second
     concurrent false-description dispute cannot be filled, and fails over after 360 s.
   - A seller can therefore defeat a valid claim cheaply, either by occupying the pool with other
     disputes, or by getting one juror to withhold a reveal when the other two split.
   - One minority slash (0.05) or non-reveal slash (0.125) drops a 0.3 juror below 0.25. That juror
     is then ineligible until topped up.
   - Recommended: more jurors, and stake for at least 2 seats.
   - Also note: `services/jurors` defaults to a target stake of `2 × jurorStake` = 0.5 USDC. That is
     more than the 0.3 in the funding plan, so set `JUROR_STAKE` or fund 0.5.
3. **Mechanical verdict race after `verifierDeadline`.** Both `resolveMechanical` and
   `timeoutMechanical` are valid after the deadline. The seller always prefers the timeout, so in
   practice 1800 s is a hard deadline for the verifier. `PreviewNotReproducible` reruns must finish
   inside it.
4. **Trusted roles.**
   - The owner picks the runner, relay and verifier, and approves jurors. A compromised owner or TEE
     key can therefore direct refunds up to the 50% cap plus penalties, but cannot take escrow or
     balances directly.
   - `renounceOwnership` would strand the treasury, the reserve and the params.
   - Ownership transfer is single-step. Use a multisig, and consider `Ownable2Step`.
5. **Views module.** The fallback delegatecalls an immutable `viewsModule` that is not
   zero-checked. Verify its bytecode on basescan together with EnvMarket.
6. **Reputation.** Identity is per address. Wash trades at the 2% fee can inflate `qualifyingTx`,
   `retainedVolume` and ratings. Self-dealing detection is off-chain.
7. **Bond on partial success.** Any confirmed task returns the full bond, but the refund covers only
   the confirmed tasks. Over-claiming therefore costs nothing extra once one task is confirmed.
   This follows the spec.
8. **USDC controls.**
   - A blacklisted account's `claimable` is stuck, and only theirs.
     (`testForkBlacklistedRecipientDoesNotBrickSettlement`)
   - If the market itself is blacklisted, or USDC is paused, deposits and withdrawals stop.
     Internal settlement keeps working.
9. **Juror registry.** `MAX_JURORS = 200` counts revoked entries, which are never removed.
10. **PreviewReport does not bind `ciphertextHash`.** The relay must sign a delivery only for
    ciphertexts it has verified decrypt to `bundleHash`. The TEE keys uploads by ciphertextHash.
    This is off-chain trust.

## Addendum: seller-paid previews (2026-09-10)

Scope: `requestPreview`, `reclaimPreviewFee`, the paid-preview gate in `attachReport`, and the
preview config setters. Tests: `test/Preview.t.sol`, the preview handler paths in
`test/Invariant.t.sol`, and `testForkSellerPaysPreviewWithRealUsdc`.

**F-4 (Low, fixed in the design): reclaim-and-downgrade.** A `PreviewReport` signature binds
versionId, bundleHash and reportHash, but not the fee. With the specified design, a seller could:

1. pay the TEE's quote;
2. obtain the signed report (for example from `POST /preview`);
3. wait out `previewTimeout` before anyone attaches it;
4. reclaim the fee;
5. re-request at `minPreviewFee`;
6. attach the old signature.

That pays `minPreviewFee` instead of the quote. **Fix:** after a reclaim, the next `requestPreview`
for the version must pay at least the reclaimed fee (`PreviewFeeTooLow(fee, reclaimedFee)`). The
EIP-712 type is unchanged, so TEE signing code is unaffected. Test: `testReclaimBeforeTimeoutRevertsAfterWorks`.

**Checked:**
- **Conservation.** The new bucket `totalPreviewFees()` counts requested fees that have been neither
  released nor reclaimed. Every fee moves only between the seller's wallet, this bucket and
  `claimable` (recipient or seller), and it moves exactly once. `released` and `reclaimed` are
  mutually exclusive. `reportHash != 0` holds exactly when the version's preview was released.
  The invariant fuzzer covers request, attach, reclaim and re-request.
- **Checks-effects-interactions.** `requestPreview` writes state before `safeTransferFrom`. It skips
  the transfer for a zero fee. Attach and reclaim only credit `claimable`.
- **Access and state gates.**
  - Only the version's seller can request or reclaim.
  - Request needs no report and no outstanding preview.
  - Reclaim needs no report, an outstanding preview, and `now > paidAt + timeout`.
  - Attach needs an outstanding preview, so it is impossible after a reclaim until the seller pays again.
  - A late attach, after the timeout but before any reclaim, is valid, so a slow TEE still gets paid.
- **Snapshots.**
  - The timeout is snapshotted per request. The owner cannot extend a pending one to block a refund.
  - Raising `minPreviewFee` does not invalidate a preview that is already paid.
  - The recipient is read at attach time.
  - A zero recipient or zero timeout reverts `InvalidParams`.
- **Layout.** The new state is appended after `claimable` in `EnvMarketStorage`, so EnvMarket and
  EnvMarketViews still share slots. EnvMarket's own EIP712 and Ownable slots move down. This needs a
  fresh deployment, as every version does (no proxy).

**Residual:**
1. The fee-to-quote check is off-chain. The TEE must verify `previewInfo.fee ≥ quote` and the
   quoteHash before running. On-chain, only `minPreviewFee` is enforced.
2. If a TEE run outlives `previewDeadline`, the seller can reclaim before the attach. The TEE is then
   unpaid until the seller re-requests, which the seller must do to list at all, paying at least the
   same fee. The TEE should attach immediately after signing, and should not start a run it cannot
   finish before the deadline.
3. The owner can redirect `previewFeeRecipient` before an attach. This is trusted-owner scope,
   like the other roles.

## Results

- `forge test`: 76 tests (59 at the original review, then +17 for seller-paid previews). All pass
  except the 6 fork tests, which are skipped without `BASE_RPC`.
- `BASE_RPC=https://mainnet.base.org forge test --mc ForkUSDC`: 6 of 6 pass against real Base USDC.
  This includes preview fees of 0.2 USDC and 2.13 USDC (the measured preview cost).
- `forge build --sizes`: EnvMarket runtime 23,371 B (1,205 B under EIP-170). It was 22,056 B before the
  preview functions.
