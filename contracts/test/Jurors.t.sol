// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MarketBase, S} from "./Base.t.sol";

contract JurorFlowTest is MarketBase {
    function setUp() public override {
        super.setUp();
        _addJurors(3);
    }

    function _fdDispute() internal returns (uint256 pid, uint256 did) {
        (, pid) = _delivered();
        did = _dispute(pid, S.Ground.FalseDescription, 1); // 1 task => requested 20, bond 20
    }

    function _stake(address j) internal view returns (uint256 total, uint256 locked) {
        (, total, locked,) = V.jurorInfo(j);
    }

    // FalseDescription: 2 Uphold vs 1 Reject (minority), early reveal once all committed.
    function testFalseDescriptionMajorityAndMinority() public {
        (uint256 pid, uint256 did) = _fdDispute();
        (S.Dispute memory d,) = V.getDispute(did);
        assertEq(uint8(d.status), uint8(S.DisputeStatus.AwaitingSelection));
        assertEq(d.round, 1);
        assertEq(d.selectionBlock, block.number + 2);
        assertEq(d.bond, 20 * U);
        assertEq(d.requested, 20 * U);

        vm.roll(d.selectionBlock); // not yet past the selection block
        vm.expectRevert(S.TooEarly.selector);
        market.selectJurors(did);

        _select(did);
        address[3] memory pnl = _panel(did, 1);
        (d,) = V.getDispute(did);
        assertEq(uint8(d.status), uint8(S.DisputeStatus.Voting));
        assertEq(d.commitDeadline, block.timestamp + 180);
        assertEq(d.revealDeadline, block.timestamp + 360);
        for (uint256 k; k < 3; ++k) {
            (, uint256 locked) = _stake(pnl[k]);
            assertEq(locked, 20 * U);
        }
        vm.expectRevert(S.WrongState.selector);
        market.selectJurors(did);

        // commit phase guards
        vm.prank(buyer);
        vm.expectRevert(S.NotSeated.selector);
        market.commitVote(did, keccak256("x"));
        _commit(did, 1, pnl[0], S.Verdict.Uphold);
        vm.prank(pnl[0]);
        vm.expectRevert(S.AlreadyCommitted.selector);
        market.commitVote(did, keccak256("x"));
        vm.prank(pnl[0]);
        vm.expectRevert(S.TooEarly.selector); // not everyone committed and commit window open
        market.revealVote(did, S.Verdict.Uphold, _salt(pnl[0], did));
        _commit(did, 1, pnl[1], S.Verdict.Uphold);
        _commit(did, 1, pnl[2], S.Verdict.Reject);

        // all committed: reveal may start early
        vm.prank(pnl[2]);
        vm.expectRevert(S.CommitmentMismatch.selector);
        market.revealVote(did, S.Verdict.Uphold, _salt(pnl[2], did)); // different verdict than committed
        vm.prank(pnl[2]);
        vm.expectRevert(S.CommitmentMismatch.selector);
        market.revealVote(did, S.Verdict.Reject, keccak256("wrong salt"));
        vm.prank(pnl[2]);
        vm.expectRevert(S.BadVerdict.selector);
        market.revealVote(did, S.Verdict.None, _salt(pnl[2], did));
        _reveal(did, pnl[0], S.Verdict.Uphold);
        vm.prank(pnl[0]);
        vm.expectRevert(S.AlreadyRevealed.selector);
        market.revealVote(did, S.Verdict.Uphold, _salt(pnl[0], did));
        _reveal(did, pnl[1], S.Verdict.Uphold);
        vm.expectRevert(S.TooEarly.selector); // 2 of 3 revealed, reveal window still open
        market.tallyDispute(did);
        _reveal(did, pnl[2], S.Verdict.Reject);
        market.tallyDispute(did); // all revealed: tally early

        (S.Dispute memory r, S.Seat[6] memory seats) = V.getDispute(did);
        assertEq(uint8(r.status), uint8(S.DisputeStatus.Resolved));
        assertEq(uint8(r.verdict), uint8(S.Verdict.Uphold));
        assertEq(r.refund, 20 * U);
        assertEq(r.confirmedMask, 1);
        assertFalse(r.fallbackNoQuorum);

        // buyer: refund 20 + bond 20
        assertEq(market.claimable(buyer), 40 * U);
        // seller: retained 80, fee 1.6, proceeds 78.4
        assertEq(market.claimable(seller), 78_400_000);
        assertEq(market.treasury(), 1_600_000);
        // collateral: caseFee 6 + penalty 10 (1/5 tasks > 5%)
        (uint256 tot, uint256 res,) = V.sellerStake(seller);
        assertEq(tot, 84 * U);
        assertEq(res, 0);
        assertEq(market.reserve(), 10 * U);
        // jurors: pot 6 → 1 participation each, remaining 3 + minority slash 4 → 3.5 per majority seat
        assertEq(market.claimable(pnl[0]), 4_500_000);
        assertEq(market.claimable(pnl[1]), 4_500_000);
        assertEq(market.claimable(pnl[2]), 1 * U);
        (uint256 t2, uint256 l2) = _stake(pnl[2]);
        assertEq(t2, 36 * U);
        assertEq(l2, 0);
        (uint256 t0, uint256 l0) = _stake(pnl[0]);
        assertEq(t0, 40 * U);
        assertEq(l0, 0);
        assertEq(seats[2].slashed, 4 * U);
        assertEq(seats[0].reward, 4_500_000);
        assertEq(uint8(seats[2].vote), uint8(S.Verdict.Reject));

        S.Purchase memory p = V.getPurchase(pid);
        assertEq(uint8(p.state), uint8(S.PurchaseState.Settled));
        assertEq(p.refunded, 20 * U);
        assertEq(p.penalties, 10 * U);
        assertEq(p.remediedMask, 1);
        S.SellerStats memory ss = V.sellerStats(seller);
        assertEq(ss.disputesOpened, 1);
        assertEq(ss.disputesUpheld, 1);
        assertEq(ss.qualifyingTx, 1);
        assertEq(ss.retainedVolume, 80 * U);

        vm.expectRevert(S.WrongState.selector);
        market.tallyDispute(did); // settles once
        _checkConservation();

        vm.prank(buyer);
        market.rate(pid, 2, 0);
        assertEq(V.sellerStats(seller).weightedRatingSum, 160 * U); // retained 80 × 2 stars

        for (uint256 k; k < 3; ++k) {
            vm.prank(pnl[k]);
            market.withdraw();
        }
        assertEq(token.balanceOf(pnl[0]), 4_500_000);
        _checkConservation();
    }

    // Two Reject reveals + one non-reveal: bond pays case fee to jurors, rest to reserve.
    function testFalseDescriptionRejectWithNonReveal() public {
        (uint256 pid, uint256 did) = _fdDispute();
        _select(did);
        address[3] memory pnl = _panel(did, 1);
        _commit(did, 1, pnl[0], S.Verdict.Reject);
        _commit(did, 1, pnl[1], S.Verdict.Reject);
        (S.Dispute memory d,) = V.getDispute(did);

        vm.warp(d.commitDeadline + 1);
        vm.prank(pnl[2]);
        vm.expectRevert(S.DeadlinePassed.selector); // late commit
        market.commitVote(did, keccak256("late"));
        _reveal(did, pnl[0], S.Verdict.Reject);
        _reveal(did, pnl[1], S.Verdict.Reject);
        vm.expectRevert(S.TooEarly.selector);
        market.tallyDispute(did);

        vm.warp(d.revealDeadline + 1);
        vm.prank(pnl[1]);
        vm.expectRevert(S.DeadlinePassed.selector); // late reveal
        market.revealVote(did, S.Verdict.Reject, _salt(pnl[1], did));
        market.tallyDispute(did);

        (S.Dispute memory r,) = V.getDispute(did);
        assertEq(uint8(r.verdict), uint8(S.Verdict.Reject));
        assertEq(r.refund, 0);
        assertEq(market.claimable(buyer), 0);
        assertEq(market.claimable(seller), 98 * U); // never receives the forfeited bond
        assertEq(market.treasury(), 2 * U);
        (uint256 tot,,) = V.sellerStake(seller);
        assertEq(tot, 100 * U);
        // reserve: bond 20 - caseFee 6 = 14, plus non-reveal slash 50% of 20 = 10
        assertEq(market.reserve(), 24 * U);
        // revealers: participation 1 + (6 - 2)/2 = 3 each
        assertEq(market.claimable(pnl[0]), 3 * U);
        assertEq(market.claimable(pnl[1]), 3 * U);
        assertEq(market.claimable(pnl[2]), 0);
        (uint256 t2, uint256 l2) = _stake(pnl[2]);
        assertEq(t2, 30 * U);
        assertEq(l2, 0);
        assertEq(uint8(V.getPurchase(pid).state), uint8(S.PurchaseState.Settled));
        assertEq(V.sellerStats(seller).disputesUpheld, 0);
        _checkConservation();
    }

    // Round 1 insufficient reveals → non-revealers slashed → fresh round-2 panel decides.
    function testRound2Replacement() public {
        _addJurors(3); // 6 jurors
        (, uint256 did) = _fdDispute();
        _select(did);
        address[3] memory r1 = _panel(did, 1);
        _commit(did, 1, r1[0], S.Verdict.Uphold);
        (S.Dispute memory d,) = V.getDispute(did);
        vm.warp(d.commitDeadline + 1);
        _reveal(did, r1[0], S.Verdict.Uphold);
        vm.warp(d.revealDeadline + 1);
        market.tallyDispute(did);

        (d,) = V.getDispute(did);
        assertEq(d.round, 2);
        assertEq(uint8(d.status), uint8(S.DisputeStatus.AwaitingSelection));
        assertEq(market.reserve(), 20 * U); // two non-reveal slashes
        (uint256 t0, uint256 l0) = _stake(r1[0]);
        assertEq(t0, 40 * U);
        assertEq(l0, 0);
        assertEq(market.claimable(r1[0]), 0);
        _checkConservation();

        _select(did);
        address[3] memory r2 = _panel(did, 2);
        for (uint256 a; a < 3; ++a) {
            for (uint256 b; b < 3; ++b) {
                assertTrue(r2[a] != r1[b], "round-2 juror reused");
            }
        }
        vm.prank(r1[0]);
        vm.expectRevert(S.NotSeated.selector); // round-1 juror has no round-2 seat
        market.commitVote(did, keccak256("x"));
        for (uint256 k; k < 3; ++k) {
            _commit(did, 2, r2[k], S.Verdict.Uphold);
        }
        for (uint256 k; k < 3; ++k) {
            _reveal(did, r2[k], S.Verdict.Uphold);
        }
        market.tallyDispute(did);
        (d,) = V.getDispute(did);
        assertEq(uint8(d.verdict), uint8(S.Verdict.Uphold));
        assertEq(market.claimable(buyer), 40 * U);
        for (uint256 k; k < 3; ++k) {
            assertEq(market.claimable(r2[k]), 2 * U); // 1 participation + 3/3 remainder
        }
        assertEq(market.reserve(), 30 * U); // + 10 penalty
        _checkConservation();
    }

    // Round 2 also insufficient (1–1 split + non-reveal) → FallbackNoQuorum.
    function testRound2FallbackNoQuorum() public {
        _addJurors(3);
        (uint256 pid, uint256 did) = _fdDispute();
        _select(did);
        (S.Dispute memory d,) = V.getDispute(did);
        vm.warp(d.revealDeadline + 1);
        market.tallyDispute(did); // zero reveals
        assertEq(market.reserve(), 30 * U);

        _select(did);
        address[3] memory r2 = _panel(did, 2);
        _commit(did, 2, r2[0], S.Verdict.Uphold);
        _commit(did, 2, r2[1], S.Verdict.Reject);
        (d,) = V.getDispute(did);
        vm.warp(d.commitDeadline + 1);
        _reveal(did, r2[0], S.Verdict.Uphold);
        _reveal(did, r2[1], S.Verdict.Reject);
        vm.warp(d.revealDeadline + 1);
        vm.expectEmit(true, true, false, false, address(market));
        emit FallbackNoQuorum(did, pid);
        market.tallyDispute(did);

        (d,) = V.getDispute(did);
        assertEq(uint8(d.status), uint8(S.DisputeStatus.Resolved));
        assertEq(uint8(d.verdict), uint8(S.Verdict.Reject));
        assertTrue(d.fallbackNoQuorum);
        assertEq(market.claimable(buyer), 20 * U); // bond returned in full, no refund
        assertEq(market.claimable(seller), 98 * U); // settles normally
        assertEq(market.treasury(), 2 * U);
        assertEq(market.reserve(), 40 * U); // 3 + 1 non-reveal slashes
        assertEq(market.claimable(r2[0]), 0);
        assertEq(uint8(V.getPurchase(pid).state), uint8(S.PurchaseState.Settled));
        (uint256 tot, uint256 res,) = V.sellerStake(seller);
        assertEq(tot, 100 * U);
        assertEq(res, 0);
        _checkConservation();
    }

    event FallbackNoQuorum(uint256 indexed disputeId, uint256 indexed purchaseId);

    // Only 3 jurors: round 2 cannot be filled with fresh jurors → waits the grace period → fallback.
    function testRound2UnfillableFallsBackAfterGrace() public {
        (, uint256 did) = _fdDispute();
        _select(did);
        (S.Dispute memory d,) = V.getDispute(did);
        vm.warp(d.revealDeadline + 1);
        market.tallyDispute(did);
        (d,) = V.getDispute(did);
        vm.roll(uint256(d.selectionBlock) + 1);
        vm.setBlockhash(d.selectionBlock, keccak256("bh2"));
        vm.expectRevert(S.NotEnoughJurors.selector);
        market.selectJurors(did);
        vm.warp(d.selectionDeadline + 1);
        market.selectJurors(did);
        (d,) = V.getDispute(did);
        assertTrue(d.fallbackNoQuorum);
        assertEq(market.claimable(buyer), 20 * U);
        _checkConservation();
    }

    function testSelectionRearmsWhenBlockhashExpired() public {
        (, uint256 did) = _fdDispute();
        (S.Dispute memory d,) = V.getDispute(did);
        vm.roll(uint256(d.selectionBlock) + 300); // blockhash() now returns 0
        market.selectJurors(did);
        (S.Dispute memory d2,) = V.getDispute(did);
        assertEq(d2.selectionBlock, block.number + 2);
        assertEq(uint8(d2.status), uint8(S.DisputeStatus.AwaitingSelection));
        _select(did);
        (d2,) = V.getDispute(did);
        assertEq(uint8(d2.status), uint8(S.DisputeStatus.Voting));
    }

    function testSelectionExcludesPartiesAndLowStake() public {
        // buyer and seller are approved, well-staked jurors; one juror has too little free stake
        market.approveJuror(buyer, true);
        market.approveJuror(seller, true);
        _fund(buyer, 100 * U);
        vm.prank(buyer);
        market.depositJurorStake(100 * U);
        _fund(seller, 100 * U);
        vm.prank(seller);
        market.depositJurorStake(100 * U);
        address low = makeAddr("lowstake");
        market.approveJuror(low, true);
        _fund(low, 10 * U);
        vm.prank(low);
        market.depositJurorStake(10 * U);
        address revoked = makeAddr("revoked");
        market.approveJuror(revoked, true);
        _fund(revoked, 40 * U);
        vm.prank(revoked);
        market.depositJurorStake(40 * U);
        market.approveJuror(revoked, false);

        (, uint256 did) = _fdDispute();
        _select(did);
        address[3] memory pnl = _panel(did, 1);
        for (uint256 k; k < 3; ++k) {
            assertTrue(pnl[k] == jurors[0] || pnl[k] == jurors[1] || pnl[k] == jurors[2], "ineligible juror seated");
        }
        assertTrue(pnl[0] != pnl[1] && pnl[1] != pnl[2] && pnl[0] != pnl[2], "duplicate seat");
    }

    function testJurorStakeRules() public {
        address outsider = makeAddr("outsider");
        _fund(outsider, 10 * U);
        vm.prank(outsider);
        vm.expectRevert(S.JurorNotApproved.selector);
        market.depositJurorStake(10 * U);

        (, uint256 did) = _fdDispute();
        _select(did);
        address j = _panel(did, 1)[0];
        vm.prank(j);
        vm.expectRevert(abi.encodeWithSelector(S.InsufficientStake.selector, 20 * U, 21 * U));
        market.withdrawJurorStake(21 * U);
        vm.prank(j);
        market.withdrawJurorStake(20 * U);
        (, uint256 tot, uint256 locked, uint256 free) = V.jurorInfo(j);
        assertEq(tot, 20 * U);
        assertEq(locked, 20 * U);
        assertEq(free, 0);
        _checkConservation();
    }

    function testCommitmentEncoding() public view {
        bytes32 salt = keccak256("s");
        assertEq(
            market.commitmentFor(5, 2, S.Verdict.Reject, salt, jurors[0]),
            keccak256(abi.encode(uint256(5), uint256(2), uint256(2), salt, jurors[0]))
        );
    }
}
