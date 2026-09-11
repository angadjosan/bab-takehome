// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MarketBase, S} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EnvMarket} from "../src/EnvMarket.sol";
import {EnvMarketViews} from "../src/EnvMarketViews.sol";
import {MarketParams} from "../script/MarketParams.sol";

/// Regression tests for findings in contracts/SECURITY_REVIEW.md.
contract SecurityReviewTest is MarketBase {
    function _fd() internal returns (uint256 pid, uint256 did) {
        (, pid) = _delivered();
        did = _dispute(pid, S.Ground.FalseDescription, 1);
    }

    function _sameSet(address[3] memory a, address[3] memory b) internal pure returns (bool) {
        for (uint256 i; i < 3; ++i) {
            if (a[i] != b[0] && a[i] != b[1] && a[i] != b[2]) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------------------------------
    // F-1 (Medium): re-arming an expired selection block must not push back the grace deadline.
    // With commit+reveal longer than 256 blocks, every call either reverted (NotEnoughJurors, blockhash
    // still valid, deadline not reached) or re-armed (blockhash expired) and reset the deadline, so an
    // unfillable panel never failed over to round 2 / the fallback: escrow + collateral locked forever.
    // ------------------------------------------------------------------------------------------
    function testRearmDoesNotExtendSelectionGrace() public {
        S.Params memory p = demoParams();
        p.commitWindow = 1 hours; // grace = 2h, far longer than 256 blocks of blockhash history
        p.revealWindow = 1 hours;
        market.setParams(p);
        _addJurors(2); // panel can never be filled

        (uint256 pid, uint256 did) = _fd();
        (S.Dispute memory d,) = V.getDispute(did);
        uint64 deadline0 = d.selectionDeadline;

        // Keepers poll every ~10 minutes; each poll lands after blockhash expiry and re-arms.
        uint256 bn = block.number; // tracked locally: via_ir may cache block.* inside a test
        uint256 ts = block.timestamp;
        for (uint256 i; i < 13; ++i) {
            ts += 600;
            bn += 300;
            vm.warp(ts);
            vm.roll(bn);
            market.selectJurors(did);
            (d,) = V.getDispute(did);
            assertEq(uint8(d.status), uint8(S.DisputeStatus.AwaitingSelection));
            assertEq(d.selectionDeadline, deadline0, "re-arm moved the grace deadline");
        }
        assertGt(ts, deadline0);
        // A call with a live blockhash after the original deadline fails the round over.
        _select(did);
        (d,) = V.getDispute(did);
        assertEq(d.round, 2, "round 1 did not fail over");

        vm.warp(d.selectionDeadline + 1);
        _select(did);
        (d,) = V.getDispute(did);
        assertTrue(d.fallbackNoQuorum, "round 2 did not fall back");
        assertEq(uint8(V.getPurchase(pid).state), uint8(S.PurchaseState.Settled));
        _checkConservation();
    }

    // ------------------------------------------------------------------------------------------
    // F-2 (Low): a juror can re-roll the whole panel by toggling their own eligibility.
    // The seed is public one block before selectJurors can land; with a Fisher-Yates draw over the
    // list-ordered pool, removing/adding any one juror shifts every index and re-rolls everyone.
    // Seats must depend only on each juror's own draw, so a juror can at most remove themself.
    // ------------------------------------------------------------------------------------------
    function testNonSeatedJurorCannotRerollPanel() public {
        _addJurors(8);
        (, uint256 did) = _fd();
        uint256 snap = vm.snapshotState();
        _select(did);
        address[3] memory base = _panel(did, 1);
        vm.revertToState(snap);

        for (uint256 i; i < jurors.length; ++i) {
            address x = jurors[i];
            if (x == base[0] || x == base[1] || x == base[2]) continue;
            snap = vm.snapshotState();
            vm.prank(x);
            market.withdrawJurorStake(40 * U); // x drops out of the pool
            _select(did);
            assertTrue(_sameSet(_panel(did, 1), base), "an unseated juror changed the panel");
            vm.revertToState(snap);
        }
    }

    function testSeatedJurorLeavingOnlyReplacesThemself() public {
        _addJurors(8);
        (, uint256 did) = _fd();
        uint256 snap = vm.snapshotState();
        _select(did);
        address[3] memory base = _panel(did, 1);
        vm.revertToState(snap);

        for (uint256 k; k < 3; ++k) {
            snap = vm.snapshotState();
            vm.prank(base[k]);
            market.withdrawJurorStake(40 * U);
            _select(did);
            address[3] memory pnl = _panel(did, 1);
            for (uint256 m; m < 3; ++m) {
                if (m == k) continue;
                assertTrue(pnl[0] == base[m] || pnl[1] == base[m] || pnl[2] == base[m], "other seat changed");
            }
            vm.revertToState(snap);
        }
    }

    // A juror who (re)stakes after the selection block (i.e. once the seed inputs are public) is not
    // eligible for that draw, so nobody can opt in to a panel they already know they would land on.
    function testStakeAddedAfterSelectionBlockIsIneligible() public {
        _addJurors(2);
        address late = makeAddr("late-juror");
        market.approveJuror(late, true);
        _fund(late, 40 * U);

        (, uint256 did) = _fd();
        (S.Dispute memory d,) = V.getDispute(did);
        vm.roll(uint256(d.selectionBlock) + 1);
        vm.prank(late);
        market.depositJurorStake(40 * U);
        vm.setBlockhash(d.selectionBlock, keccak256("bh"));
        vm.expectRevert(S.NotEnoughJurors.selector);
        market.selectJurors(did);
    }

    function testStakeAtOrBeforeSelectionBlockIsEligible() public {
        _addJurors(2);
        address j3 = makeAddr("j3");
        market.approveJuror(j3, true);
        _fund(j3, 40 * U);
        (, uint256 did) = _fd();
        (S.Dispute memory d,) = V.getDispute(did);
        vm.roll(d.selectionBlock); // blockhash(selectionBlock) is not known yet
        vm.prank(j3);
        market.depositJurorStake(40 * U);
        _select(did);
        (d,) = V.getDispute(did);
        assertEq(uint8(d.status), uint8(S.DisputeStatus.Voting));
    }

    // ------------------------------------------------------------------------------------------
    // F-3 (Informational): uint128 truncation on deposits broke the bucket accounting.
    // ------------------------------------------------------------------------------------------
    function testDepositsAboveUint128Revert() public {
        uint256 huge = uint256(type(uint128).max) + 2;
        _fund(seller, huge);
        vm.prank(seller);
        vm.expectRevert();
        market.depositCollateral(huge);

        address j = makeAddr("j");
        market.approveJuror(j, true);
        _fund(j, huge);
        vm.prank(j);
        vm.expectRevert();
        market.depositJurorStake(huge);
    }

    // ------------------------------------------------------------------------------------------
    // Properties checked during review (pass before and after fixes).
    // ------------------------------------------------------------------------------------------

    /// Signatures are bound to this contract: a relay receipt for market A is useless on market B.
    function testSignatureNotReplayableAcrossDeployments() public {
        EnvMarket other = new EnvMarket(IERC20(address(token)), address(new EnvMarketViews()), address(this), demoParams());
        other.setRelay(relay, true);
        other.setRunner(runner, true);
        (, uint256 pid) = _delivered();
        // same ids on the second market
        _fund(seller, 100 * U);
        vm.startPrank(seller);
        token.approve(address(other), type(uint256).max);
        other.depositCollateral(100 * U);
        uint256 vid2 = other.createListing(_input(5, uint128(100 * U), uint128(100 * U)));
        vm.stopPrank();
        bytes memory reportSigA = _sign(runnerPk, market.previewReportDigest(vid2, BUNDLE, REPORT));
        vm.expectRevert(S.BadSignature.selector);
        other.attachReport(vid2, REPORT, reportSigA);
        other.attachReport(vid2, REPORT, _sign(runnerPk, other.previewReportDigest(vid2, BUNDLE, REPORT)));
        _fund(buyer, 100 * U);
        vm.startPrank(buyer);
        token.approve(address(other), type(uint256).max);
        uint256 pid2 = other.buy(vid2, ENC_KEY, 100 * U);
        vm.stopPrank();
        assertEq(pid2, pid);
        bytes32 wk = keccak256(abi.encode("wrappedKey", pid));
        bytes32 wr = keccak256(abi.encode("wrapper", pid));
        bytes memory sigA = _sign(relayPk, market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, wk, wr));
        vm.expectRevert(S.BadSignature.selector);
        other.recordDelivery(pid2, CIPHER, wk, wr, sigA);
    }

    /// High-s (malleated) signatures are rejected.
    function testMalleatedSignatureRejected() public {
        uint256 vid = _listDefault();
        uint256 pid = _buy(buyer, vid);
        bytes32 wk = keccak256("wk");
        bytes32 digest = market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, wk, wk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(relayPk, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory mal = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(S.BadSignature.selector);
        market.recordDelivery(pid, CIPHER, wk, wk, mal);
        market.recordDelivery(pid, CIPHER, wk, wk, abi.encodePacked(r, s, v));
    }

    /// Copying another juror's commitment gains nothing: it cannot be revealed by the copier.
    function testCopiedCommitmentCannotBeRevealed() public {
        _addJurors(3);
        (, uint256 did) = _fd();
        _select(did);
        address[3] memory pnl = _panel(did, 1);
        bytes32 c0 = market.commitmentFor(did, 1, S.Verdict.Uphold, _salt(pnl[0], did), pnl[0]);
        vm.prank(pnl[0]);
        market.commitVote(did, c0);
        vm.prank(pnl[1]);
        market.commitVote(did, c0); // copy
        _commit(did, 1, pnl[2], S.Verdict.Reject);
        vm.prank(pnl[1]);
        vm.expectRevert(S.CommitmentMismatch.selector);
        market.revealVote(did, S.Verdict.Uphold, _salt(pnl[0], did));
    }

    /// The fallback only reaches read-only code; unknown selectors revert.
    function testFallbackRejectsUnknownSelectors() public {
        (bool ok,) = address(market).call(abi.encodeWithSignature("transfer(address,uint256)", buyer, 1));
        assertFalse(ok);
        (ok,) = address(market).call(hex"01");
        assertFalse(ok);
        (ok,) = address(market).call{value: 1}(abi.encodeWithSignature("params()"));
        assertFalse(ok); // non-payable
    }

    // ------------------------------------------------------------------------------------------
    // Mainnet (8453) parameter set for the 5 USDC demo budget: price 0.5, collateral 0.5.
    // ------------------------------------------------------------------------------------------
    function _mainnetMarket() internal {
        market = new EnvMarket(IERC20(address(token)), address(new EnvMarketViews()), address(this), MarketParams.mainnet());
        V = EnvMarketViews(address(market));
        market.setRunner(runner, true);
        market.setRelay(relay, true);
        market.setVerifier(verifier, true);
        for (uint256 i; i < 3; ++i) {
            address j = makeAddr(string.concat("mj", vm.toString(i)));
            jurors.push(j);
            market.approveJuror(j, true);
            _fund(j, 500_000);
            vm.prank(j);
            market.depositJurorStake(500_000);
        }
    }

    function testMainnetParamValues() public pure {
        S.Params memory p = MarketParams.mainnet();
        assertEq(p.bondFloor, 50_000);
        assertEq(p.bondCap, 500_000);
        assertEq(p.caseFee, 100_000);
        assertEq(p.participationFee, 20_000);
        assertEq(p.jurorStake, 250_000);
        assertEq(p.challengeWindow, 300);
        assertEq(p.deliveryWindow, 600);
        assertEq(p.commitWindow, 180);
        assertEq(p.revealWindow, 180);
    }

    function testMainnetParamsFinalizeAndMechanical() public {
        _mainnetMarket();
        // collateral requirement: caseFee 0.10 + 10% × 0.5 = 0.15 <= 0.5
        uint256 vid = _list(seller, 5, 500_000, 500_000, 1_000_000);
        uint256 p1 = _buy(buyer, vid);
        _deliver(p1);
        vm.warp(block.timestamp + 301);
        market.finalize(p1);
        assertEq(market.claimable(seller), 490_000); // fee 2% = 10_000
        assertEq(market.treasury(), 10_000);

        uint256 p2 = _buy(buyer2, vid);
        _deliver(p2);
        (uint256 req, uint256 bond) = V.quoteDispute(p2, 0x3);
        assertEq(req, 200_000); // 2 × 100_000 per task
        assertEq(bond, 200_000);
        uint256 did = _dispute(p2, S.Ground.BrokenOrHashMismatch, 0x3);
        bytes32 fh = keccak256("f");
        market.resolveMechanical(did, true, 0x1, fh, _sign(verifierPk, market.mechanicalFindingDigest(did, true, 0x1, fh)));
        assertEq(market.claimable(buyer2), 100_000 + 200_000); // refund 1 task + bond
        assertEq(market.claimable(seller), 490_000 + 392_000); // retained 400_000 - 2% fee
        (uint256 tot, uint256 res,) = V.sellerStake(seller);
        assertEq(res, 0);
        assertEq(tot, 1_000_000 - 100_000 - 50_000); // caseFee + 10% penalty (1/5 > 5%)
        _checkConservation();
    }

    function testMainnetParamsJuryUpheldAndRejected() public {
        _mainnetMarket();
        uint256 vid = _list(seller, 5, 500_000, 500_000, 1_000_000);

        // upheld 2–1: pot 0.10 → 0.02 each + (0.04 + minority slash 0.05) / 2 majority
        uint256 p1 = _buy(buyer, vid);
        _deliver(p1);
        uint256 d1 = _dispute(p1, S.Ground.FalseDescription, 0x1);
        _select(d1);
        address[3] memory pnl = _panel(d1, 1);
        _commit(d1, 1, pnl[0], S.Verdict.Uphold);
        _commit(d1, 1, pnl[1], S.Verdict.Uphold);
        _commit(d1, 1, pnl[2], S.Verdict.Reject);
        _reveal(d1, pnl[0], S.Verdict.Uphold);
        _reveal(d1, pnl[1], S.Verdict.Uphold);
        _reveal(d1, pnl[2], S.Verdict.Reject);
        market.tallyDispute(d1);
        assertEq(market.claimable(pnl[0]), 20_000 + 45_000);
        assertEq(market.claimable(pnl[2]), 20_000);
        assertEq(market.claimable(buyer), 100_000 + 100_000); // refund + bond (bond = requested 0.1)
        _checkConservation();

        // rejected with a floor-sized bond (1 task = 0.1 ≥ floor 0.05) and one non-revealer
        uint256 p2 = _buy(buyer2, vid);
        _deliver(p2);
        uint256 d2 = _dispute(p2, S.Ground.FalseDescription, 0x1);
        _select(d2);
        pnl = _panel(d2, 1);
        _commit(d2, 1, pnl[0], S.Verdict.Reject);
        _commit(d2, 1, pnl[1], S.Verdict.Reject);
        (S.Dispute memory d,) = V.getDispute(d2);
        vm.warp(d.commitDeadline + 1);
        _reveal(d2, pnl[0], S.Verdict.Reject);
        _reveal(d2, pnl[1], S.Verdict.Reject);
        vm.warp(d.revealDeadline + 1);
        market.tallyDispute(d2);
        // bond 0.1 = caseFee → pot 0.1: 0.02 each + 0.06/2 → 0.05 each, reserve gets 50% of 0.25 stake
        assertEq(market.claimable(buyer2), 0);
        (d,) = V.getDispute(d2);
        assertEq(uint8(d.verdict), uint8(S.Verdict.Reject));
        _checkConservation();
    }
}
