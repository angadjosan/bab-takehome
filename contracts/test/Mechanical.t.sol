// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MarketBase, S} from "./Base.t.sol";

contract MechanicalDisputeTest is MarketBase {
    bytes32 constant FINDINGS = keccak256("findings");

    function _resolve(uint256 did, bool upheld, uint256 mask) internal {
        bytes memory sig = _sign(verifierPk, market.mechanicalFindingDigest(did, upheld, mask, FINDINGS));
        market.resolveMechanical(did, upheld, mask, FINDINGS, sig);
    }

    function testMechanicalUpheld() public {
        (, uint256 pid) = _delivered();
        uint256 did = _dispute(pid, S.Ground.BrokenOrHashMismatch, 0x3);
        (S.Dispute memory d,) = V.getDispute(did);
        assertEq(d.requested, 40 * U);
        assertEq(d.bond, 40 * U);
        assertEq(uint8(d.status), uint8(S.DisputeStatus.Voting));
        assertEq(d.verifierDeadline, block.timestamp + 1800);
        _checkConservation();

        _resolve(did, true, 0x1);
        (d,) = V.getDispute(did);
        assertEq(uint8(d.verdict), uint8(S.Verdict.Uphold));
        assertEq(d.refund, 20 * U);
        assertEq(d.findingsHash, FINDINGS);
        assertEq(market.claimable(buyer), 60 * U); // refund 20 + bond 40
        assertEq(market.claimable(seller), 78_400_000); // (100-20) - 2%
        assertEq(market.treasury(), 1_600_000 + 6 * U); // fee + case fee (verifier cost)
        assertEq(market.reserve(), 10 * U); // penalty
        (uint256 tot, uint256 res,) = V.sellerStake(seller);
        assertEq(tot, 84 * U);
        assertEq(res, 0);
        _checkConservation();

        bytes memory sig = _sign(verifierPk, market.mechanicalFindingDigest(did, true, 0x1, FINDINGS));
        vm.expectRevert(S.WrongState.selector);
        market.resolveMechanical(did, true, 0x1, FINDINGS, sig); // settles once
    }

    function testMechanicalRejected() public {
        (, uint256 pid) = _delivered();
        uint256 did = _dispute(pid, S.Ground.PreviewNotReproducible, 0x3);
        _resolve(did, false, 0);
        assertEq(market.claimable(buyer), 0);
        assertEq(market.claimable(seller), 98 * U);
        assertEq(market.treasury(), 2 * U + 6 * U);
        assertEq(market.reserve(), 34 * U); // bond 40 - case fee 6
        (uint256 tot,,) = V.sellerStake(seller);
        assertEq(tot, 100 * U);
        _checkConservation();
    }

    function testMechanicalMaskRules() public {
        (, uint256 pid) = _delivered();
        uint256 did = _dispute(pid, S.Ground.BrokenOrHashMismatch, 0x3);
        bytes memory s1 = _sign(verifierPk, market.mechanicalFindingDigest(did, true, 0x4, FINDINGS));
        bytes memory s2 = _sign(verifierPk, market.mechanicalFindingDigest(did, true, 0, FINDINGS));
        bytes memory s3 = _sign(verifierPk, market.mechanicalFindingDigest(did, false, 1, FINDINGS));
        vm.expectRevert(S.BadMask.selector);
        market.resolveMechanical(did, true, 0x4, FINDINGS, s1); // not a subset of taskMask
        vm.expectRevert(S.BadMask.selector);
        market.resolveMechanical(did, true, 0, FINDINGS, s2);
        vm.expectRevert(S.BadMask.selector);
        market.resolveMechanical(did, false, 1, FINDINGS, s3);
    }

    function testMechanicalSignatureBinding() public {
        (, uint256 pid) = _delivered();
        uint256 did = _dispute(pid, S.Ground.BrokenOrHashMismatch, 0x3);
        bytes memory byMallory = _sign(malloryPk, market.mechanicalFindingDigest(did, true, 0x1, FINDINGS));
        bytes memory byRelay = _sign(relayPk, market.mechanicalFindingDigest(did, true, 0x1, FINDINGS));
        bytes memory good = _sign(verifierPk, market.mechanicalFindingDigest(did, true, 0x1, FINDINGS));
        bytes memory otherDispute = _sign(verifierPk, market.mechanicalFindingDigest(did + 1, true, 0x1, FINDINGS));

        vm.expectRevert(S.BadSignature.selector);
        market.resolveMechanical(did, true, 0x1, FINDINGS, byMallory);
        vm.expectRevert(S.BadSignature.selector);
        market.resolveMechanical(did, true, 0x1, FINDINGS, byRelay);
        vm.expectRevert(S.BadSignature.selector);
        market.resolveMechanical(did, true, 0x1, FINDINGS, otherDispute);
        vm.expectRevert(S.BadSignature.selector);
        market.resolveMechanical(did, true, 0x3, FINDINGS, good); // different mask
        vm.expectRevert(S.BadSignature.selector);
        market.resolveMechanical(did, true, 0x1, keccak256("other findings"), good);
        vm.expectRevert(S.BadMask.selector);
        market.resolveMechanical(did, false, 0x1, FINDINGS, good); // flipped verdict (mask rule first)
        bytes memory rejectSig = _sign(verifierPk, market.mechanicalFindingDigest(did, true, 0, FINDINGS));
        vm.expectRevert(S.BadSignature.selector);
        market.resolveMechanical(did, false, 0, FINDINGS, rejectSig); // sig was for upheld=true
        vm.prank(mallory);
        market.resolveMechanical(did, true, 0x1, FINDINGS, good);
    }

    function testMechanicalWrongGround() public {
        (, uint256 pid) = _delivered();
        uint256 did = _dispute(pid, S.Ground.FalseDescription, 1);
        bytes memory sig = _sign(verifierPk, market.mechanicalFindingDigest(did, true, 1, FINDINGS));
        vm.expectRevert(S.BadGround.selector);
        market.resolveMechanical(did, true, 1, FINDINGS, sig);
        vm.expectRevert(S.BadGround.selector);
        market.timeoutMechanical(did);
    }

    function testVerifierTimeoutFallback() public {
        (, uint256 pid) = _delivered();
        uint256 did = _dispute(pid, S.Ground.BrokenOrHashMismatch, 0x3);
        (S.Dispute memory d,) = V.getDispute(did);
        vm.warp(d.verifierDeadline);
        vm.expectRevert(S.DeadlineNotPassed.selector);
        market.timeoutMechanical(did);
        vm.warp(d.verifierDeadline + 1);
        market.timeoutMechanical(did);
        (d,) = V.getDispute(did);
        assertTrue(d.fallbackNoQuorum);
        assertEq(market.claimable(buyer), 40 * U);
        assertEq(market.claimable(seller), 98 * U);
        assertEq(uint8(V.getPurchase(pid).state), uint8(S.PurchaseState.Settled));
        bytes memory sig = _sign(verifierPk, market.mechanicalFindingDigest(did, true, 1, FINDINGS));
        vm.expectRevert(S.WrongState.selector);
        market.resolveMechanical(did, true, 1, FINDINGS, sig);
        _checkConservation();
    }

    function testRefundCapAndDedup() public {
        (, uint256 pid) = _delivered();
        uint256 did = _dispute(pid, S.Ground.BrokenOrHashMismatch, 0x1f);
        (S.Dispute memory d,) = V.getDispute(did);
        assertEq(d.requested, 50 * U); // min(5 × 20, 50% cap)
        assertEq(d.bond, 50 * U); // clamp(50, 5, 50)
        _resolve(did, true, 0x1f);
        S.Purchase memory p = V.getPurchase(pid);
        assertEq(p.refunded, 50 * U); // capped, not 100
        assertEq(p.remediedMask, 0x1f); // each task remedied once
        assertEq(market.claimable(buyer), 100 * U); // 50 refund + 50 bond
        assertEq(market.claimable(seller), 49 * U); // 50 retained - 2%
        assertEq(market.reserve(), 10 * U);
        assertEq(market.treasury(), 1 * U + 6 * U);
        _checkConservation();
    }

    function testBondFloorAndCap() public {
        uint256 small = _list(seller, 5, uint128(10 * U), uint128(10 * U), 10 * U);
        uint256 p1 = _buy(buyer, small);
        (uint256 req, uint256 bond) = V.quoteDispute(p1, 1);
        assertEq(req, 2 * U);
        assertEq(bond, 5 * U); // floor
        uint256 big = _list(seller2, 5, uint128(1000 * U), uint128(1000 * U), 1000 * U);
        uint256 p2 = _buy(buyer2, big);
        (req, bond) = V.quoteDispute(p2, 0x1f);
        assertEq(req, 500 * U); // 50% cap
        assertEq(bond, 50 * U); // cap

        // bond below the case fee: loser pays only what the bond holds
        _deliver(p1);
        uint256 did = _dispute(p1, S.Ground.BrokenOrHashMismatch, 1);
        _resolve(did, false, 0);
        assertEq(market.treasury(), 6 * U - 1 * U + 200_000); // min(caseFee 6, bond 5) + 2% of 10
        _checkConservation();
    }

    function testPenaltyThreshold() public {
        // 40 tasks: 2 confirmed = 5% (not > threshold), 3 confirmed = 7.5% (> threshold)
        uint256 vid = _list(seller, 40, uint128(100 * U), uint128(100 * U), 200 * U);
        uint256 pa = _buy(buyer, vid);
        uint256 pb = _buy(buyer2, vid);
        _deliver(pa);
        _deliver(pb);
        uint256 da = _dispute(pa, S.Ground.BrokenOrHashMismatch, 0x3);
        uint256 db = _dispute(pb, S.Ground.BrokenOrHashMismatch, 0x7);
        _resolve(da, true, 0x3);
        assertEq(V.getPurchase(pa).penalties, 0);
        assertEq(market.reserve(), 0);
        assertEq(market.claimable(buyer), 5 * U + 5 * U); // refund 2×2.5 + bond clamp(5)=5
        _resolve(db, true, 0x7);
        assertEq(V.getPurchase(pb).penalties, 10 * U);
        assertEq(market.reserve(), 10 * U);
        (uint256 tot,,) = V.sellerStake(seller);
        assertEq(tot, 200 * U - 6 * U - 6 * U - 10 * U);
        _checkConservation();
    }

    // ------------------------------------------------------------------ fuzz
    function testFuzz_MechanicalSettlement(uint16 taskCount, uint128 price, uint256 mask, uint256 conf, bool upheld)
        public
    {
        taskCount = uint16(bound(taskCount, 1, 256));
        price = uint128(bound(price, 1, 1e15));
        uint256 collateral = 6 * U + uint256(price) * 1000 / 10_000;
        uint256 vid = _list(seller, taskCount, price, uint128(collateral), collateral);
        uint256 pid = _buy(buyer, vid);
        _deliver(pid);
        if (taskCount < 256) mask &= (uint256(1) << taskCount) - 1;
        if (mask == 0) mask = 1;
        conf &= mask;
        if (conf == 0) conf = mask;
        uint256 did = _dispute(pid, S.Ground.BrokenOrHashMismatch, mask);
        (S.Dispute memory d,) = V.getDispute(did);
        _resolve(did, upheld, upheld ? conf : 0);

        uint256 cap = uint256(price) * 5000 / 10_000;
        uint256 expected = upheld ? _pop(conf) * (uint256(price) / taskCount) : 0;
        if (expected > cap) expected = cap;
        S.Purchase memory p = V.getPurchase(pid);
        assertEq(p.refunded, expected);
        assertLe(p.refunded, cap);
        assertEq(market.claimable(buyer), upheld ? expected + d.bond : 0);
        assertEq(p.sellerProceeds + p.fee + p.refunded, price);
        _checkConservation();
    }

    function _pop(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            x &= x - 1;
            c++;
        }
    }
}
