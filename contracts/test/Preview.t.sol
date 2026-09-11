// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MarketBase, S} from "./Base.t.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Seller-paid preview inference: requestPreview escrows the fee, attachReport releases it to the
/// preview fee recipient (TEE operator), reclaimPreviewFee refunds it after the timeout.
contract PreviewFeeTest is MarketBase {
    event PreviewRequested(uint256 indexed versionId, address indexed seller, uint256 fee, bytes32 quoteHash);
    event PreviewFeeReleased(uint256 indexed versionId, address indexed recipient, uint256 fee);
    event PreviewFeeReclaimed(uint256 indexed versionId, address indexed seller, uint256 fee);
    event PreviewConfigUpdated(address recipient, uint256 minFee, uint32 timeout);

    address operator = makeAddr("tee-operator");

    function setUp() public override {
        super.setUp();
        market.setPreviewFeeRecipient(operator);
    }

    function _newVersion() internal returns (uint256 vid) {
        vm.prank(seller);
        vid = market.createListing(_input(5, uint128(100 * U), uint128(100 * U)));
    }

    function _reportSig(uint256 vid) internal view returns (bytes memory) {
        return _sign(runnerPk, market.previewReportDigest(vid, BUNDLE, REPORT));
    }

    function _info(uint256 vid)
        internal
        view
        returns (uint256 fee, uint256 paidAt, bytes32 qh, bool released, bool reclaimed)
    {
        return V.previewInfo(vid);
    }

    // ------------------------------------------------------------------ config
    function testDefaultsAndOwnerOnlyConfig() public {
        // fresh deployment defaults: recipient = initial owner, min 0, timeout 3600
        assertEq(V.minPreviewFee(), 0);
        assertEq(V.previewTimeout(), 3600);
        assertEq(V.previewFeeRecipient(), operator);
        market.setPreviewFeeRecipient(address(this));
        assertEq(V.previewFeeRecipient(), address(this));

        vm.expectEmit(address(market));
        emit PreviewConfigUpdated(address(this), 5 * U, 3600);
        market.setMinPreviewFee(uint128(5 * U));
        market.setPreviewTimeout(7200);
        assertEq(V.minPreviewFee(), 5 * U);
        assertEq(V.previewTimeout(), 7200);

        vm.expectRevert(S.InvalidParams.selector);
        market.setPreviewFeeRecipient(address(0));
        vm.expectRevert(S.InvalidParams.selector);
        market.setPreviewTimeout(0);

        vm.startPrank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        market.setPreviewFeeRecipient(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        market.setMinPreviewFee(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        market.setPreviewTimeout(1);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- happy path
    function testPayThenAttachReleasesToRecipient() public {
        uint256 vid = _newVersion();
        _fund(seller, 3 * U);
        vm.expectEmit(address(market));
        emit PreviewRequested(vid, seller, 3 * U, QUOTE);
        vm.prank(seller);
        market.requestPreview(vid, 3 * U, QUOTE);

        (uint256 fee, uint256 paidAt, bytes32 qh, bool released, bool reclaimed) = _info(vid);
        assertEq(fee, 3 * U);
        assertEq(paidAt, block.timestamp);
        assertEq(qh, QUOTE);
        assertFalse(released);
        assertFalse(reclaimed);
        assertEq(token.balanceOf(seller), 0);
        assertEq(token.balanceOf(address(market)), 3 * U);
        assertEq(V.totalPreviewFees(), 3 * U);
        assertEq(V.previewDeadline(vid), block.timestamp + 3600);
        _checkConservation();

        vm.expectEmit(address(market));
        emit PreviewFeeReleased(vid, operator, 3 * U);
        vm.prank(mallory); // anyone may submit the runner-signed report
        market.attachReport(vid, REPORT, _reportSig(vid));

        (,,, released,) = _info(vid);
        assertTrue(released);
        assertEq(V.getVersion(vid).reportHash, REPORT);
        assertEq(V.totalPreviewFees(), 0);
        assertEq(market.claimable(operator), 3 * U);
        _checkConservation();
        vm.prank(operator);
        market.withdraw();
        assertEq(token.balanceOf(operator), 3 * U);
        _checkConservation();

        // the version is now buyable as before
        _fund(seller, 100 * U);
        vm.prank(seller);
        market.depositCollateral(100 * U);
        _buy(buyer, vid);
        _checkConservation();
    }

    /// Recipient is read at attach time (owner may rotate the TEE operator's payout address).
    function testRecipientReadAtAttach() public {
        uint256 vid = _newVersion();
        _requestPreview(seller, vid, 2 * U);
        address op2 = makeAddr("tee-operator-2");
        market.setPreviewFeeRecipient(op2);
        market.attachReport(vid, REPORT, _reportSig(vid));
        assertEq(market.claimable(op2), 2 * U);
        assertEq(market.claimable(operator), 0);
    }

    function testZeroFeeRequestWhenMinIsZero() public {
        uint256 vid = _newVersion();
        vm.prank(seller);
        market.requestPreview(vid, 0, bytes32(0)); // no allowance needed for a zero fee
        (, uint256 paidAt,,,) = _info(vid);
        assertEq(paidAt, block.timestamp);
        vm.prank(seller);
        vm.expectRevert(S.PreviewAlreadyPaid.selector);
        market.requestPreview(vid, 0, bytes32(0));
        market.attachReport(vid, REPORT, _reportSig(vid));
        assertEq(market.claimable(operator), 0);
        _checkConservation();
    }

    // ----------------------------------------------------------------- reverts
    function testAttachWithoutRequestReverts() public {
        uint256 vid = _newVersion();
        bytes memory sig = _reportSig(vid);
        vm.expectRevert(S.PreviewNotPaid.selector); // also when minPreviewFee == 0
        market.attachReport(vid, REPORT, sig);
        market.setMinPreviewFee(uint128(U));
        vm.expectRevert(S.PreviewNotPaid.selector);
        market.attachReport(vid, REPORT, sig);
    }

    function testNonSellerRequestReverts() public {
        uint256 vid = _newVersion();
        _fund(buyer, U);
        vm.prank(buyer);
        vm.expectRevert(S.Unauthorized.selector);
        market.requestPreview(vid, U, QUOTE);
        vm.prank(seller);
        vm.expectRevert(S.UnknownVersion.selector);
        market.requestPreview(vid + 1, U, QUOTE);
    }

    function testDoubleRequestReverts() public {
        uint256 vid = _newVersion();
        _requestPreview(seller, vid, U);
        _fund(seller, U);
        vm.prank(seller);
        vm.expectRevert(S.PreviewAlreadyPaid.selector);
        market.requestPreview(vid, U, QUOTE);
        // still refused after the timeout while unreclaimed
        vm.warp(block.timestamp + 3601);
        vm.prank(seller);
        vm.expectRevert(S.PreviewAlreadyPaid.selector);
        market.requestPreview(vid, U, QUOTE);
    }

    function testRequestAfterReportReverts() public {
        uint256 vid = _list(seller, 5, uint128(100 * U), uint128(100 * U), 0);
        _fund(seller, U);
        vm.prank(seller);
        vm.expectRevert(S.ReportAlreadyAttached.selector);
        market.requestPreview(vid, U, QUOTE);
    }

    function testFeeBelowMinReverts() public {
        market.setMinPreviewFee(uint128(2 * U));
        uint256 vid = _newVersion();
        _fund(seller, 2 * U);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(S.PreviewFeeTooLow.selector, U, 2 * U));
        market.requestPreview(vid, U, QUOTE);
        vm.prank(seller);
        market.requestPreview(vid, 2 * U, QUOTE);
        // raising the minimum later does not affect an already-paid preview
        market.setMinPreviewFee(uint128(10 * U));
        market.attachReport(vid, REPORT, _reportSig(vid));
        assertEq(market.claimable(operator), 2 * U);
    }

    // ------------------------------------------------------------------ reclaim
    function testReclaimBeforeTimeoutRevertsAfterWorks() public {
        uint256 vid = _newVersion();
        _requestPreview(seller, vid, 3 * U);
        uint256 deadline = V.previewDeadline(vid);

        vm.warp(deadline);
        vm.prank(seller);
        vm.expectRevert(S.DeadlineNotPassed.selector);
        market.reclaimPreviewFee(vid);

        vm.warp(deadline + 1);
        vm.prank(buyer);
        vm.expectRevert(S.Unauthorized.selector);
        market.reclaimPreviewFee(vid);

        vm.expectEmit(address(market));
        emit PreviewFeeReclaimed(vid, seller, 3 * U);
        vm.prank(seller);
        market.reclaimPreviewFee(vid);
        (uint256 fee,,, bool released, bool reclaimed) = _info(vid);
        assertEq(fee, 3 * U);
        assertFalse(released);
        assertTrue(reclaimed);
        assertEq(market.claimable(seller), 3 * U);
        assertEq(V.totalPreviewFees(), 0);
        _checkConservation();

        vm.prank(seller);
        vm.expectRevert(S.PreviewNotPaid.selector);
        market.reclaimPreviewFee(vid);

        // a report can no longer be attached against the reclaimed payment
        bytes memory sig = _reportSig(vid);
        vm.expectRevert(S.PreviewNotPaid.selector);
        market.attachReport(vid, REPORT, sig);

        // re-request: at least the reclaimed fee (report sigs don't bind the fee)
        _fund(seller, 3 * U);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(S.PreviewFeeTooLow.selector, U, 3 * U));
        market.requestPreview(vid, U, QUOTE);
        vm.prank(seller);
        market.requestPreview(vid, 3 * U, keccak256("quote-2"));
        (, uint256 paidAt, bytes32 qh,, bool rec2) = _info(vid);
        assertEq(paidAt, block.timestamp);
        assertEq(qh, keccak256("quote-2"));
        assertFalse(rec2);
        market.attachReport(vid, REPORT, sig);
        assertEq(market.claimable(operator), 3 * U);
        _checkConservation();
    }

    function testReclaimAfterAttachImpossible() public {
        uint256 vid = _newVersion();
        _requestPreview(seller, vid, 3 * U);
        vm.warp(block.timestamp + 3601); // a late attach is still valid while unreclaimed
        market.attachReport(vid, REPORT, _reportSig(vid));
        vm.prank(seller);
        vm.expectRevert(S.ReportAlreadyAttached.selector);
        market.reclaimPreviewFee(vid);
        assertEq(market.claimable(operator), 3 * U);
        assertEq(market.claimable(seller), 0);
    }

    function testReclaimWithoutRequestReverts() public {
        uint256 vid = _newVersion();
        vm.prank(seller);
        vm.expectRevert(S.PreviewNotPaid.selector);
        market.reclaimPreviewFee(vid);
        vm.prank(seller);
        vm.expectRevert(S.UnknownVersion.selector);
        market.reclaimPreviewFee(vid + 1);
    }

    /// The timeout is snapshotted per request: the owner cannot extend (or shorten) a pending one.
    function testTimeoutSnapshottedAtRequest() public {
        uint256 vid = _newVersion();
        _requestPreview(seller, vid, U);
        market.setPreviewTimeout(30 days);
        vm.warp(block.timestamp + 3601);
        vm.prank(seller);
        market.reclaimPreviewFee(vid);
        assertEq(market.claimable(seller), U);
    }

    function testFuzzRequestAttachOrReclaim(uint96 fee, uint32 wait, bool attach) public {
        uint256 vid = _newVersion();
        _requestPreview(seller, vid, fee);
        vm.warp(block.timestamp + wait);
        if (attach) {
            market.attachReport(vid, REPORT, _reportSig(vid));
            assertEq(market.claimable(operator), fee);
        } else if (wait > 3600) {
            vm.prank(seller);
            market.reclaimPreviewFee(vid);
            assertEq(market.claimable(seller), fee);
        } else {
            vm.prank(seller);
            vm.expectRevert(S.DeadlineNotPassed.selector);
            market.reclaimPreviewFee(vid);
        }
        _checkConservation();
    }
}
