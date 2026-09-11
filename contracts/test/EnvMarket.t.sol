// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MarketBase, S} from "./Base.t.sol";
import {EnvMarket} from "../src/EnvMarket.sol";
import {EnvMarketViews} from "../src/EnvMarketViews.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract EnvMarketCoreTest is MarketBase {
    // ------------------------------------------------------------ happy path
    function testHappyPathFinalize() public {
        (uint256 vid, uint256 pid) = _delivered();
        S.Purchase memory p = V.getPurchase(pid);
        assertEq(uint8(p.state), uint8(S.PurchaseState.Delivered));
        assertEq(p.challengeDeadline, block.timestamp + 300);
        (uint256 tot, uint256 res, uint256 av) = V.sellerStake(seller);
        assertEq(tot, 100 * U);
        assertEq(res, 100 * U);
        assertEq(av, 0);
        _checkConservation();

        vm.warp(p.challengeDeadline + 1);
        market.finalize(pid);

        p = V.getPurchase(pid);
        assertEq(uint8(p.state), uint8(S.PurchaseState.Settled));
        assertEq(p.sellerProceeds, 98 * U);
        assertEq(p.fee, 2 * U);
        assertEq(market.claimable(seller), 98 * U);
        assertEq(market.treasury(), 2 * U);
        (, res, av) = V.sellerStake(seller);
        assertEq(res, 0);
        assertEq(av, 100 * U);

        S.VersionStats memory vs = V.versionStats(vid);
        assertEq(vs.settledCount, 1);
        assertEq(vs.retainedVolume, 100 * U);
        (uint256 q, bool eligible,,) = V.sellerScore(seller);
        assertEq(q, 1);
        assertFalse(eligible);
        _checkConservation();

        vm.prank(seller);
        market.withdraw();
        assertEq(token.balanceOf(seller), 98 * U);
        assertEq(market.claimable(seller), 0);
        vm.prank(seller);
        vm.expectRevert(S.ZeroValue.selector);
        market.withdraw();

        vm.prank(buyer);
        market.rate(pid, 5, keccak256("great"));
        vs = V.versionStats(vid);
        assertEq(vs.ratingSum, 5);
        assertEq(vs.ratingCount, 1);
        S.SellerStats memory ss = V.sellerStats(seller);
        assertEq(ss.weightedRatingSum, 500 * U);
        assertEq(ss.ratedRetained, 100 * U);

        // owner withdraws treasury
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.withdrawTreasury(buyer, 1);
        vm.expectRevert(S.InsufficientFunds.selector);
        market.withdrawTreasury(address(0xBEEF), 2 * U + 1);
        market.withdrawTreasury(address(0xBEEF), 2 * U);
        assertEq(token.balanceOf(address(0xBEEF)), 2 * U);
        vm.expectRevert(S.InsufficientFunds.selector);
        market.withdrawReserve(address(0xBEEF), 1);
        _checkConservation();
    }

    function testSettleOnce() public {
        (, uint256 pid) = _delivered();
        vm.warp(V.getPurchase(pid).challengeDeadline + 1);
        market.finalize(pid);
        vm.expectRevert(S.WrongState.selector);
        market.finalize(pid);
        vm.expectRevert(S.WrongState.selector);
        market.refundUndelivered(pid);
        vm.prank(buyer);
        vm.expectRevert(S.WrongState.selector);
        market.openDispute(pid, S.Ground.FalseDescription, 1, 0);
        assertEq(market.claimable(seller), 98 * U);
        _checkConservation();
    }

    // -------------------------------------------------------- delivery window
    function testDeliveryTimeoutRefund() public {
        uint256 vid = _listDefault();
        uint256 pid = _buy(buyer, vid);
        S.Purchase memory p = V.getPurchase(pid);
        assertEq(p.deliveryDeadline, block.timestamp + 600);

        vm.warp(p.deliveryDeadline);
        vm.expectRevert(S.DeadlineNotPassed.selector);
        market.refundUndelivered(pid);

        vm.warp(p.deliveryDeadline + 1);
        market.refundUndelivered(pid);
        p = V.getPurchase(pid);
        assertEq(uint8(p.state), uint8(S.PurchaseState.Refunded));
        assertEq(market.claimable(buyer), 100 * U);
        (, uint256 res,) = V.sellerStake(seller);
        assertEq(res, 0);
        assertEq(V.sellerStats(seller).fullRefunds, 1);
        assertEq(V.sellerStats(seller).qualifyingTx, 0);

        // cannot deliver afterwards, cannot rate an undelivered purchase, cannot refund twice
        bytes memory sig = _sign(relayPk, market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, bytes32(0), bytes32(0)));
        vm.expectRevert(S.WrongState.selector);
        market.recordDelivery(pid, CIPHER, bytes32(0), bytes32(0), sig);
        vm.prank(buyer);
        vm.expectRevert(S.NotEligible.selector);
        market.rate(pid, 5, 0);
        vm.expectRevert(S.WrongState.selector);
        market.refundUndelivered(pid);
        _checkConservation();

        vm.prank(buyer);
        market.withdraw();
        assertEq(token.balanceOf(buyer), 100 * U);
        _checkConservation();
    }

    function testDeliveryExactlyAtDeadline() public {
        uint256 pid = _buy(buyer, _listDefault());
        vm.warp(V.getPurchase(pid).deliveryDeadline);
        _deliver(pid);
        assertEq(uint8(V.getPurchase(pid).state), uint8(S.PurchaseState.Delivered));
    }

    function testDeliveryAfterDeadlineReverts() public {
        uint256 pid = _buy(buyer, _listDefault());
        vm.warp(V.getPurchase(pid).deliveryDeadline + 1);
        bytes memory sig = _sign(relayPk, market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, bytes32(0), bytes32(0)));
        vm.expectRevert(S.DeadlinePassed.selector);
        market.recordDelivery(pid, CIPHER, bytes32(0), bytes32(0), sig);
    }

    // ------------------------------------------------------- challenge window
    function testDisputeExactlyAtChallengeDeadline() public {
        (, uint256 pid) = _delivered();
        vm.warp(V.getPurchase(pid).challengeDeadline);
        vm.expectRevert(S.DeadlineNotPassed.selector);
        market.finalize(pid);
        uint256 did = _dispute(pid, S.Ground.BrokenOrHashMismatch, 1);
        assertEq(did, 1);
        assertEq(uint8(V.getPurchase(pid).state), uint8(S.PurchaseState.Disputed));
        // timely dispute freezes settlement
        vm.warp(block.timestamp + 10_000);
        vm.expectRevert(S.WrongState.selector);
        market.finalize(pid);
        vm.prank(buyer);
        vm.expectRevert(S.WrongState.selector);
        market.openDispute(pid, S.Ground.FalseDescription, 2, 0); // one dispute per purchase
        _checkConservation();
    }

    function testLateDisputeRejected() public {
        (, uint256 pid) = _delivered();
        vm.warp(V.getPurchase(pid).challengeDeadline + 1);
        _fund(buyer, 50 * U);
        vm.prank(buyer);
        vm.expectRevert(S.DeadlinePassed.selector);
        market.openDispute(pid, S.Ground.FalseDescription, 1, 0);
        market.finalize(pid);
        _checkConservation();
    }

    function testOnlyAllowedGrounds() public {
        (, uint256 pid) = _delivered();
        _fund(buyer, 50 * U);
        vm.startPrank(buyer);
        vm.expectRevert(S.BadGround.selector);
        market.openDispute(pid, S.Ground.None, 1, 0);
        // out-of-range enum value (e.g. "reward hacking") is rejected at ABI decoding
        (bool ok,) = address(market).call(
            abi.encodeWithSelector(EnvMarket.openDispute.selector, pid, uint8(4), uint256(1), bytes32(0))
        );
        assertFalse(ok);
        vm.expectRevert(S.BadMask.selector);
        market.openDispute(pid, S.Ground.FalseDescription, 0, 0);
        vm.expectRevert(S.BadMask.selector);
        market.openDispute(pid, S.Ground.FalseDescription, 1 << 5, 0); // taskCount = 5
        vm.stopPrank();
        vm.prank(seller);
        vm.expectRevert(S.Unauthorized.selector);
        market.openDispute(pid, S.Ground.FalseDescription, 1, 0);
        // all three allowed grounds are accepted
        for (uint8 g = 1; g <= 3; ++g) {
            uint256 p2 = _buy(buyer2, _list(seller2, 5, uint128(100 * U), uint128(100 * U), 100 * U));
            _deliver(p2);
            _dispute(p2, S.Ground(g), 1);
        }
        _checkConservation();
    }

    // ------------------------------------------------------------- collateral
    function testCollateralCannotBackTwoPurchases() public {
        uint256 vid = _listDefault();
        uint256 pid = _buy(buyer, vid);
        _fund(buyer2, 100 * U);
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(S.InsufficientCollateral.selector, 0, 100 * U));
        market.buy(vid, ENC_KEY, 100 * U);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(S.InsufficientCollateral.selector, 0, 1));
        market.withdrawCollateral(1);

        _deliver(pid);
        vm.warp(V.getPurchase(pid).challengeDeadline + 1);
        market.finalize(pid);
        vm.prank(buyer2);
        uint256 pid2 = market.buy(vid, ENC_KEY, 100 * U);
        assertEq(pid2, 2);
        (uint256 tot, uint256 res, uint256 av) = V.sellerStake(seller);
        assertEq(tot, 100 * U);
        assertEq(res, 100 * U);
        assertEq(av, 0);

        _fund(seller, 30 * U);
        vm.startPrank(seller);
        market.depositCollateral(30 * U);
        market.withdrawCollateral(30 * U);
        vm.stopPrank();
        _checkConservation();
    }

    function testCollateralBelowRequirement() public {
        uint256 vid = _list(seller, 5, uint128(100 * U), uint128(10 * U), 100 * U);
        _fund(buyer, 100 * U);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(S.CollateralBelowRequirement.selector, 10 * U, 16 * U));
        market.buy(vid, ENC_KEY, 100 * U);
    }

    function testBuyGuards() public {
        uint256 vid = _listDefault();
        _fund(buyer, 100 * U);
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(S.PriceAboveMax.selector, 100 * U, 99 * U));
        market.buy(vid, ENC_KEY, 99 * U);
        vm.expectRevert(S.ZeroValue.selector);
        market.buy(vid, bytes32(0), 100 * U);
        vm.expectRevert(S.UnknownVersion.selector);
        market.buy(99, ENC_KEY, 100 * U);
        vm.stopPrank();
        _fund(seller, 100 * U);
        vm.prank(seller);
        vm.expectRevert(S.SelfPurchase.selector);
        market.buy(vid, ENC_KEY, 100 * U);

        // no report attached
        vm.prank(seller);
        uint256 v2 = market.createListing(_input(5, uint128(100 * U), uint128(100 * U)));
        vm.prank(buyer);
        vm.expectRevert(S.ReportMissing.selector);
        market.buy(v2, ENC_KEY, 100 * U);

        // inactive
        vm.prank(buyer);
        vm.expectRevert(S.Unauthorized.selector);
        market.setVersionActive(vid, false);
        vm.prank(seller);
        market.setVersionActive(vid, false);
        vm.prank(buyer);
        vm.expectRevert(S.VersionInactive.selector);
        market.buy(vid, ENC_KEY, 100 * U);
    }

    // --------------------------------------------------- listings / versions
    function testVersionsAndTermsValidation() public {
        uint256 vid = _listDefault();
        S.VersionTerms memory t = V.getVersion(vid);
        assertEq(t.seller, seller);
        assertEq(t.listingId, 1);
        assertEq(t.versionNo, 1);
        assertEq(t.challengeWindow, 300); // defaulted from params
        assertEq(t.deliveryWindow, 600);
        assertEq(t.reportHash, REPORT);
        assertTrue(t.active);
        assertEq(t.uri, "https://tee.example/blobs/");

        S.VersionInput memory in2 = _input(6, uint128(120 * U), uint128(120 * U));
        in2.descriptionHash = keccak256("description v2");
        vm.prank(buyer);
        vm.expectRevert(S.Unauthorized.selector);
        market.newVersion(1, in2);
        vm.prank(seller);
        vm.expectRevert(S.UnknownListing.selector);
        market.newVersion(7, in2);
        vm.prank(seller);
        uint256 v2 = market.newVersion(1, in2);
        assertEq(V.getVersion(v2).versionNo, 2);
        assertEq(V.getVersion(vid).descriptionHash, keccak256("description")); // old version intact
        assertEq(V.listingVersionIds(1).length, 2);
        assertEq(V.listVersionIdsBySeller(seller).length, 2);
        assertEq(market.nextVersionId(), 3);
        assertEq(market.nextListingId(), 2);

        S.VersionInput memory bad = _input(0, uint128(U), uint128(U));
        vm.prank(seller);
        vm.expectRevert(S.InvalidTerms.selector);
        market.createListing(bad);
        bad = _input(257, uint128(U), uint128(U));
        vm.prank(seller);
        vm.expectRevert(S.InvalidTerms.selector);
        market.createListing(bad);
        bad = _input(5, uint128(U), uint128(U));
        bad.challengeWindow = 299; // below the market minimum
        vm.prank(seller);
        vm.expectRevert(S.InvalidTerms.selector);
        market.createListing(bad);
        bad.challengeWindow = 0;
        bad.deliveryWindow = 601; // above the market maximum
        vm.prank(seller);
        vm.expectRevert(S.InvalidTerms.selector);
        market.createListing(bad);
    }

    function testParamsSnapshotPerPurchase() public {
        (, uint256 pid) = _delivered();
        S.Params memory p = demoParams();
        p.feeBps = 1000;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.setParams(p);
        market.setParams(p);
        assertEq(V.params().feeBps, 1000);
        vm.warp(V.getPurchase(pid).challengeDeadline + 1);
        market.finalize(pid);
        assertEq(market.claimable(seller), 98 * U); // old 2% fee

        uint256 pid2 = _buy(buyer2, 1);
        _deliver(pid2);
        vm.warp(V.getPurchase(pid2).challengeDeadline + 1);
        market.finalize(pid2);
        assertEq(market.claimable(seller), 98 * U + 90 * U); // new 10% fee
        _checkConservation();

        p.bondFloor = p.bondCap + 1;
        vm.expectRevert(S.InvalidParams.selector);
        market.setParams(p);
        p = demoParams();
        p.participationFee = p.caseFee; // 3 seats * fee > caseFee
        vm.expectRevert(S.InvalidParams.selector);
        market.setParams(p);
    }

    // -------------------------------------------------------------- signatures
    function testEip712DigestsMatchIndependentEncoding() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("EnvMarket"),
                keccak256("1"),
                block.chainid,
                address(market)
            )
        );
        assertEq(market.domainSeparator(), domain);
        bytes32 a = keccak256(
            abi.encode(
                keccak256("PreviewReport(uint256 versionId,bytes32 bundleHash,bytes32 reportHash)"),
                uint256(7),
                BUNDLE,
                REPORT
            )
        );
        assertEq(market.previewReportDigest(7, BUNDLE, REPORT), keccak256(abi.encodePacked("\x19\x01", domain, a)));
        bytes32 b = keccak256(
            abi.encode(
                keccak256(
                    "DeliveryReceipt(uint256 purchaseId,bytes32 buyerEncPubKey,bytes32 ciphertextHash,bytes32 wrappedKeyHash,bytes32 wrapperHash)"
                ),
                uint256(3),
                ENC_KEY,
                CIPHER,
                bytes32(uint256(1)),
                bytes32(uint256(2))
            )
        );
        assertEq(
            market.deliveryReceiptDigest(3, ENC_KEY, CIPHER, bytes32(uint256(1)), bytes32(uint256(2))),
            keccak256(abi.encodePacked("\x19\x01", domain, b))
        );
        bytes32 c = keccak256(
            abi.encode(
                keccak256("MechanicalFinding(uint256 disputeId,bool upheld,uint256 confirmedMask,bytes32 findingsHash)"),
                uint256(9),
                true,
                uint256(5),
                bytes32(uint256(42))
            )
        );
        assertEq(
            market.mechanicalFindingDigest(9, true, 5, bytes32(uint256(42))),
            keccak256(abi.encodePacked("\x19\x01", domain, c))
        );
    }

    function testAttachReportSignatureBinding() public {
        vm.prank(seller);
        uint256 vid = market.createListing(_input(5, uint128(100 * U), uint128(100 * U)));
        bytes memory byMallory = _sign(malloryPk, market.previewReportDigest(vid, BUNDLE, REPORT));
        bytes memory otherReport = _sign(runnerPk, market.previewReportDigest(vid, BUNDLE, keccak256("x")));
        bytes memory otherBundle = _sign(runnerPk, market.previewReportDigest(vid, keccak256("x"), REPORT));
        bytes memory otherVersion = _sign(runnerPk, market.previewReportDigest(vid + 1, BUNDLE, REPORT));
        bytes memory good = _sign(runnerPk, market.previewReportDigest(vid, BUNDLE, REPORT));

        vm.expectRevert(S.BadSignature.selector);
        market.attachReport(vid, REPORT, byMallory);
        vm.expectRevert(S.BadSignature.selector);
        market.attachReport(vid, REPORT, otherReport);
        vm.expectRevert(S.BadSignature.selector);
        market.attachReport(vid, REPORT, otherBundle);
        vm.expectRevert(S.BadSignature.selector);
        market.attachReport(vid, REPORT, otherVersion);
        vm.expectRevert(S.BadSignature.selector);
        market.attachReport(vid, REPORT, hex"1234");
        vm.expectRevert(S.ZeroValue.selector);
        market.attachReport(vid, bytes32(0), good);

        vm.prank(mallory); // anyone may submit a valid runner signature
        market.attachReport(vid, REPORT, good);
        assertEq(V.getVersion(vid).reportHash, REPORT);
        vm.expectRevert(S.ReportAlreadyAttached.selector);
        market.attachReport(vid, REPORT, good);

        // revoked runner can no longer sign
        market.setRunner(runner, false);
        vm.prank(seller);
        uint256 v2 = market.createListing(_input(5, uint128(100 * U), uint128(100 * U)));
        bytes memory sig2 = _sign(runnerPk, market.previewReportDigest(v2, BUNDLE, REPORT));
        vm.expectRevert(S.BadSignature.selector);
        market.attachReport(v2, REPORT, sig2);
    }

    function testDeliverySignatureBinding() public {
        uint256 pid = _buy(buyer, _listDefault());
        bytes32 wk = keccak256("wk");
        bytes32 wr = keccak256("wr");
        bytes memory wrongCipher = _sign(relayPk, market.deliveryReceiptDigest(pid, ENC_KEY, keccak256("c2"), wk, wr));
        bytes memory wrongKey = _sign(relayPk, market.deliveryReceiptDigest(pid, keccak256("k2"), CIPHER, wk, wr));
        bytes memory wrongWk = _sign(relayPk, market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, keccak256("z"), wr));
        bytes memory wrongPid = _sign(relayPk, market.deliveryReceiptDigest(pid + 1, ENC_KEY, CIPHER, wk, wr));
        bytes memory byRunner = _sign(runnerPk, market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, wk, wr));
        bytes memory good = _sign(relayPk, market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, wk, wr));

        vm.expectRevert(S.CiphertextMismatch.selector);
        market.recordDelivery(pid, keccak256("c2"), wk, wr, wrongCipher);
        vm.expectRevert(S.BadSignature.selector);
        market.recordDelivery(pid, CIPHER, wk, wr, wrongKey);
        vm.expectRevert(S.BadSignature.selector);
        market.recordDelivery(pid, CIPHER, wk, wr, wrongWk);
        vm.expectRevert(S.BadSignature.selector);
        market.recordDelivery(pid, CIPHER, wk, wr, wrongPid);
        vm.expectRevert(S.BadSignature.selector);
        market.recordDelivery(pid, CIPHER, wk, wr, byRunner);
        vm.expectRevert(S.BadSignature.selector);
        market.recordDelivery(pid, CIPHER, keccak256("other"), wr, good);

        vm.prank(mallory);
        market.recordDelivery(pid, CIPHER, wk, wr, good);
        S.Purchase memory p = V.getPurchase(pid);
        assertEq(p.wrappedKeyHash, wk);
        assertEq(p.wrapperHash, wr);
        assertEq(p.relay, relay);
        vm.expectRevert(S.WrongState.selector);
        market.recordDelivery(pid, CIPHER, wk, wr, good);
    }

    // -------------------------------------------------------------- reputation
    function testRatingOnceAndOnlyEligible() public {
        (uint256 vid, uint256 pid) = _delivered();
        vm.prank(buyer);
        vm.expectRevert(S.NotEligible.selector);
        market.rate(pid, 4, 0); // not settled yet
        vm.warp(V.getPurchase(pid).challengeDeadline + 1);
        market.finalize(pid);
        vm.prank(seller);
        vm.expectRevert(S.Unauthorized.selector);
        market.rate(pid, 5, 0);
        vm.startPrank(buyer);
        vm.expectRevert(S.BadStars.selector);
        market.rate(pid, 0, 0);
        vm.expectRevert(S.BadStars.selector);
        market.rate(pid, 6, 0);
        market.rate(pid, 3, keccak256("ok"));
        vm.expectRevert(S.AlreadyRated.selector);
        market.rate(pid, 5, 0);
        vm.stopPrank();
        S.VersionStats memory vs = V.versionStats(vid);
        assertEq(vs.ratingSum, 3);
        assertEq(vs.ratingCount, 1);
        S.Purchase memory p = V.getPurchase(pid);
        assertTrue(p.rated);
        assertEq(p.stars, 3);
        assertEq(V.sellerStats(seller).weightedRatingSum, 300 * U);
    }

    // -------------------------------------------------------------- views
    function testViewsModuleWiring() public {
        (, uint256 pid) = _delivered();
        assertEq(V.listPurchaseIdsByBuyer(buyer)[0], pid);
        assertEq(V.listPurchaseIdsBySeller(seller)[0], pid);
        assertEq(V.params().caseFee, 6 * U);
        assertEq(V.seats(), 3);
        assertEq(V.qualifyingTxThreshold(), 100);
        (uint256 req, uint256 bond) = V.quoteDispute(pid, 0x3);
        assertEq(req, 40 * U);
        assertEq(bond, 40 * U);
        vm.expectRevert(S.UnknownPurchase.selector);
        V.quoteDispute(99, 1);
        // unknown selector reverts
        (bool ok,) = address(market).call(abi.encodeWithSignature("doesNotExist()"));
        assertFalse(ok);
        // state-changing calls cannot be smuggled through the fallback with value
        (ok,) = address(market).call{value: 1}("");
        assertFalse(ok);
        // the module on its own address sees only its own (empty) storage
        EnvMarketViews raw = EnvMarketViews(market.viewsModule());
        assertEq(raw.getPurchase(pid).price, 0);
    }
}
