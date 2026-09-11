// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {console2} from "forge-std/console2.sol";
import {MarketBase, S} from "./Base.t.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {EnvMarket} from "../src/EnvMarket.sol";
import {EnvMarketViews} from "../src/EnvMarketViews.sol";

/// Random walk over every money-moving entry point (incl. full juror cases with random
/// non-reveals and round 2). The invariant test checks conservation after every call.
contract Handler is CommonBase, StdCheats, StdUtils {
    bytes32 constant ENC = keccak256("enc");
    bytes32 constant CIPHER = keccak256("ciphertext");
    bytes32 constant BUNDLE = keccak256("bundle");

    EnvMarket market;
    EnvMarketViews V;
    TestUSDC token;
    uint256 relayPk;
    uint256 verifierPk;
    uint256 public runnerPk;
    address[] sellers;
    address[] buyers;
    address[] jurors;
    uint256[] vids;
    uint256[] pvids; // versions created by previewNew (seller-paid preview flow)

    uint256 public previewsRequested;
    uint256 public previewsAttached;
    uint256 public previewsReclaimed;

    uint256 public calls;
    uint256 public bought;
    uint256 public delivered;
    uint256 public settled;
    uint256 public mechOpened;
    uint256 public mechResolved;
    uint256 public juryResolved;

    constructor(
        EnvMarket m,
        TestUSDC t,
        uint256 relayPk_,
        uint256 verifierPk_,
        address[] memory sellers_,
        address[] memory buyers_,
        address[] memory jurors_,
        uint256[] memory vids_
    ) {
        market = m;
        V = EnvMarketViews(address(m));
        token = t;
        relayPk = relayPk_;
        verifierPk = verifierPk_;
        sellers = sellers_;
        buyers = buyers_;
        jurors = jurors_;
        vids = vids_;
    }

    function setRunnerPk(uint256 pk) external {
        runnerPk = pk;
    }

    // ------------------------------------------------------ seller-paid previews
    function previewNew(uint256 sSeed, uint256 fee) external {
        calls++;
        address s = sellers[sSeed % sellers.length];
        S.VersionInput memory v;
        v.bundleHash = BUNDLE;
        v.ciphertextHash = CIPHER;
        v.taskCount = 5;
        v.price = 10e6;
        v.collateral = 10e6; // >= caseFee 6 + 10% of price
        vm.prank(s);
        uint256 vid = market.createListing(v);
        fee = bound(fee, 0, 5e6); // minPreviewFee is 0 here, so zero-fee requests are exercised too
        _pay(s, fee);
        vm.prank(s);
        market.requestPreview(vid, fee, bytes32(fee));
        pvids.push(vid);
        previewsRequested++;
    }

    /// A version in `pvids` with an outstanding (paid, unreleased, unreclaimed) preview, or 0.
    function _pendingPreview(uint256 seed, bool wantReclaimed) internal view returns (uint256) {
        uint256 n = pvids.length;
        if (n == 0) return 0;
        uint256 start = seed % n;
        for (uint256 i; i < n; ++i) {
            uint256 vid = pvids[(start + i) % n];
            (, uint256 paidAt,, bool released, bool reclaimed) = V.previewInfo(vid);
            if (paidAt != 0 && !released && reclaimed == wantReclaimed) return vid;
        }
        return 0;
    }

    function previewAttach(uint256 seed) external {
        calls++;
        uint256 vid = _pendingPreview(seed, false);
        if (vid == 0) return;
        bytes32 rh = keccak256(abi.encode("report", vid));
        market.attachReport(vid, rh, _sig(runnerPk, market.previewReportDigest(vid, BUNDLE, rh)));
        vids.push(vid); // now buyable
        previewsAttached++;
    }

    function previewReclaim(uint256 seed) external {
        calls++;
        uint256 vid = _pendingPreview(seed, false);
        if (vid == 0 || block.timestamp <= V.previewDeadline(vid)) return;
        vm.prank(V.getVersion(vid).seller);
        market.reclaimPreviewFee(vid);
        previewsReclaimed++;
    }

    function previewReRequest(uint256 seed, uint256 extra) external {
        calls++;
        uint256 vid = _pendingPreview(seed, true);
        if (vid == 0) return;
        (uint256 old,,,,) = V.previewInfo(vid);
        uint256 fee = old + bound(extra, 0, 1e6); // must pay at least the reclaimed fee
        address s = V.getVersion(vid).seller;
        _pay(s, fee);
        vm.prank(s);
        market.requestPreview(vid, fee, bytes32(fee));
        previewsRequested++;
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pid(uint256 seed) internal view returns (uint256) {
        uint256 n = market.nextPurchaseId() - 1;
        return n == 0 ? 0 : 1 + seed % n;
    }

    /// First purchase in state `st`, scanning from a seed-chosen start (0 if none).
    function _find(uint256 seed, S.PurchaseState st) internal view returns (uint256) {
        uint256 n = market.nextPurchaseId() - 1;
        uint256 start = n == 0 ? 0 : seed % n; // reduce first: seed + i could overflow
        for (uint256 i; i < n; ++i) {
            uint256 pid = 1 + (start + i) % n;
            if (V.getPurchase(pid).state == st) return pid;
        }
        return 0;
    }

    function _did(uint256 seed) internal view returns (uint256) {
        uint256 n = market.nextDisputeId() - 1;
        return n == 0 ? 0 : 1 + seed % n;
    }

    function _pay(address who, uint256 amt) internal {
        token.mint(who, amt);
        vm.prank(who);
        token.approve(address(market), type(uint256).max);
    }

    function buy(uint256 vSeed, uint256 bSeed) external {
        calls++;
        uint256 vid = vids[vSeed % vids.length];
        address b = buyers[bSeed % buyers.length];
        uint256 price = V.getVersion(vid).price;
        _pay(b, price);
        vm.prank(b);
        try market.buy(vid, ENC, price) {
            bought++;
        } catch {}
    }

    function deliver(uint256 seed) external {
        calls++;
        uint256 pid = _find(seed, S.PurchaseState.Funded);
        if (pid == 0) return;
        S.Purchase memory p = V.getPurchase(pid);
        if (block.timestamp > p.deliveryDeadline) return;
        bytes32 wk = keccak256(abi.encode(pid));
        bytes memory sig = _sig(relayPk, market.deliveryReceiptDigest(pid, ENC, CIPHER, wk, wk));
        market.recordDelivery(pid, CIPHER, wk, wk, sig);
        delivered++;
    }

    function warp(uint256 secs) external {
        calls++;
        secs = bound(secs, 1, 400);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1 + secs % 7);
    }

    function finalize(uint256 seed) external {
        calls++;
        uint256 pid = _find(seed, S.PurchaseState.Delivered);
        if (pid == 0) return;
        try market.finalize(pid) {
            settled++;
        } catch {}
    }

    function refund(uint256 seed) external {
        calls++;
        uint256 pid = _find(seed, S.PurchaseState.Funded);
        if (pid == 0) return;
        try market.refundUndelivered(pid) {} catch {}
    }

    function disputeMech(uint256 seed, uint256 mask, bool broken) external {
        calls++;
        uint256 pid = _find(seed, S.PurchaseState.Delivered);
        if (pid == 0) return;
        S.Purchase memory p = V.getPurchase(pid);
        if (block.timestamp > p.challengeDeadline) return;
        mask = bound(mask, 1, p.taskCount >= 256 ? type(uint256).max : (uint256(1) << p.taskCount) - 1);
        (, uint256 bond) = V.quoteDispute(pid, mask);
        _pay(p.buyer, bond);
        vm.prank(p.buyer);
        market.openDispute(
            pid, broken ? S.Ground.BrokenOrHashMismatch : S.Ground.PreviewNotReproducible, mask, bytes32(seed)
        );
        mechOpened++;
    }

    function resolveMech(uint256 seed, bool upheld, uint256 conf) external {
        calls++;
        uint256 did = _did(seed);
        if (did == 0) return;
        (S.Dispute memory d,) = V.getDispute(did);
        if (d.ground == S.Ground.FalseDescription || d.status != S.DisputeStatus.Voting) return;
        uint256 mask = upheld ? conf & d.taskMask : 0;
        if (upheld && mask == 0) mask = d.taskMask;
        bytes32 fh = bytes32(conf);
        bytes memory sig = _sig(verifierPk, market.mechanicalFindingDigest(did, upheld, mask, fh));
        market.resolveMechanical(did, upheld, mask, fh, sig);
        mechResolved++;
    }

    function timeoutMech(uint256 seed) external {
        calls++;
        uint256 did = _did(seed);
        if (did == 0) return;
        try market.timeoutMechanical(did) {} catch {}
    }

    /// Open a FalseDescription dispute and run it to completion. `pattern` bits per seat:
    /// bit k = seat k reveals in round 1, bit 3+k = seat k votes Uphold; bits 6..11 same for round 2.
    function juryCase(uint256 seed, uint256 mask, uint256 pattern) external {
        calls++;
        uint256 pid = _find(seed, S.PurchaseState.Delivered);
        if (pid == 0) return;
        S.Purchase memory p = V.getPurchase(pid);
        if (block.timestamp > p.challengeDeadline) return;
        mask = bound(mask, 1, p.taskCount >= 256 ? type(uint256).max : (uint256(1) << p.taskCount) - 1);
        (, uint256 bond) = V.quoteDispute(pid, mask);
        _pay(p.buyer, bond);
        vm.prank(p.buyer);
        uint256 did = market.openDispute(pid, S.Ground.FalseDescription, mask, bytes32(seed));
        for (uint8 round = 1; round <= 2; ++round) {
            (S.Dispute memory d,) = V.getDispute(did);
            if (d.status == S.DisputeStatus.Resolved) break;
            _selectOrTimeout(did);
            (d,) = V.getDispute(did);
            if (d.status != S.DisputeStatus.Voting) continue; // unfillable round consumed
            uint256 bits = pattern >> ((round - 1) * 6);
            (, S.Seat[6] memory seats) = V.getDispute(did);
            uint256 base = (uint256(round) - 1) * 3;
            for (uint256 k; k < 3; ++k) {
                if ((bits >> k) & 1 == 0) continue;
                S.Verdict v = (bits >> (3 + k)) & 1 == 1 ? S.Verdict.Uphold : S.Verdict.Reject;
                address j = seats[base + k].juror;
                bytes32 c = market.commitmentFor(did, round, v, bytes32(seed), j);
                vm.prank(j);
                market.commitVote(did, c);
            }
            vm.warp(d.commitDeadline + 1);
            for (uint256 k; k < 3; ++k) {
                if ((bits >> k) & 1 == 0) continue;
                S.Verdict v = (bits >> (3 + k)) & 1 == 1 ? S.Verdict.Uphold : S.Verdict.Reject;
                vm.prank(seats[base + k].juror);
                market.revealVote(did, v, bytes32(seed));
            }
            vm.warp(d.revealDeadline + 1);
            market.tallyDispute(did);
        }
        (S.Dispute memory fin,) = V.getDispute(did);
        if (fin.status == S.DisputeStatus.Resolved) juryResolved++;
    }

    function _selectOrTimeout(uint256 did) internal {
        for (uint256 i; i < 3; ++i) {
            (S.Dispute memory d,) = V.getDispute(did);
            if (d.status != S.DisputeStatus.AwaitingSelection) return;
            vm.roll(uint256(d.selectionBlock) + 1);
            vm.setBlockhash(d.selectionBlock, keccak256(abi.encode(did, d.selectionBlock)));
            try market.selectJurors(did) {}
            catch {
                vm.warp(d.selectionDeadline + 1); // pool too small: wait out the grace period
            }
        }
    }

    function jurorTopUp(uint256 seed, uint256 amt) external {
        calls++;
        address j = jurors[seed % jurors.length];
        amt = bound(amt, 1, 50e6);
        _pay(j, amt);
        vm.prank(j);
        market.depositJurorStake(amt);
    }

    function jurorWithdraw(uint256 seed, uint256 amt) external {
        calls++;
        address j = jurors[seed % jurors.length];
        (,,, uint256 free) = V.jurorInfo(j);
        if (free == 0) return;
        vm.prank(j);
        market.withdrawJurorStake(bound(amt, 1, free));
    }

    function withdraw(uint256 seed) external {
        calls++;
        uint256 n = sellers.length + buyers.length + jurors.length;
        uint256 i = seed % n;
        address a = i < sellers.length
            ? sellers[i]
            : (i < sellers.length + buyers.length ? buyers[i - sellers.length] : jurors[i - sellers.length - buyers.length]);
        if (market.claimable(a) == 0) return;
        vm.prank(a);
        market.withdraw();
    }

    function sellerCollateral(uint256 seed, uint256 amt, bool deposit) external {
        calls++;
        address s = sellers[seed % sellers.length];
        if (deposit) {
            amt = bound(amt, 1, 500e6);
            _pay(s, amt);
            vm.prank(s);
            market.depositCollateral(amt);
        } else {
            (,, uint256 av) = V.sellerStake(s);
            if (av == 0) return;
            vm.prank(s);
            market.withdrawCollateral(bound(amt, 1, av));
        }
    }
}

contract InvariantTest is MarketBase {
    Handler h;

    function setUp() public override {
        super.setUp();
        _addJurors(6);
        uint256[] memory vids = new uint256[](3);
        vids[0] = _list(seller, 5, uint128(100 * U), uint128(100 * U), 300 * U);
        vids[1] = _list(seller2, 40, uint128(100 * U), uint128(100 * U), 200 * U);
        vids[2] = _list(seller, 3, uint128(7 * U), uint128(7 * U), 0); // uneven per-task split
        address[] memory ss = new address[](2);
        ss[0] = seller;
        ss[1] = seller2;
        address[] memory bs = new address[](2);
        bs[0] = buyer;
        bs[1] = buyer2;
        h = new Handler(market, token, relayPk, verifierPk, ss, bs, jurors, vids);
        h.setRunnerPk(runnerPk);
        market.setPreviewTimeout(300); // reachable within one or two warp() calls
        market.setPreviewFeeRecipient(makeAddr("tee-operator"));
        token.transferOwnership(address(h));
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](18);
        sel[14] = Handler.previewNew.selector;
        sel[15] = Handler.previewAttach.selector;
        sel[16] = Handler.previewReclaim.selector;
        sel[17] = Handler.previewReRequest.selector;
        sel[0] = Handler.buy.selector;
        sel[1] = Handler.deliver.selector;
        sel[2] = Handler.warp.selector;
        sel[3] = Handler.finalize.selector;
        sel[4] = Handler.refund.selector;
        sel[5] = Handler.disputeMech.selector;
        sel[6] = Handler.resolveMech.selector;
        sel[7] = Handler.timeoutMech.selector;
        sel[8] = Handler.juryCase.selector;
        sel[9] = Handler.jurorTopUp.selector;
        sel[10] = Handler.jurorWithdraw.selector;
        sel[11] = Handler.withdraw.selector;
        sel[12] = Handler.sellerCollateral.selector;
        sel[13] = Handler.buy.selector; // weight purchases
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_conservation() public view {
        _checkConservation();
    }

    function afterInvariant() public view {
        console2.log("calls", h.calls());
        console2.log("bought", h.bought());
        console2.log("delivered", h.delivered());
        console2.log("finalized", h.settled());
        console2.log("mech opened/resolved", h.mechOpened(), h.mechResolved());
        console2.log("jury cases resolved", h.juryResolved());
        console2.log("previews requested/attached", h.previewsRequested(), h.previewsAttached());
        console2.log("previews reclaimed", h.previewsReclaimed());
    }

    /// Deterministic walk through the preview handler paths.
    function test_handlerPreviewSmoke() public {
        h.previewNew(0, 3e6); // vid 4
        h.previewNew(1, 2e6); // vid 5
        assertEq(h.previewsRequested(), 2);
        _checkConservation();
        h.previewAttach(0);
        assertEq(h.previewsAttached(), 1);
        h.previewReclaim(0); // too early: no-op
        assertEq(h.previewsReclaimed(), 0);
        h.warp(400);
        h.warp(400);
        h.previewReclaim(0);
        assertEq(h.previewsReclaimed(), 1);
        _checkConservation();
        h.previewReRequest(0, 5e5);
        assertEq(h.previewsRequested(), 3);
        h.previewAttach(0);
        assertEq(h.previewsAttached(), 2);
        h.buy(3, 0); // vids[3] = first attached preview version
        assertEq(h.bought(), 1);
        _checkConservation();
    }

    /// Deterministic walk through every handler path, proving none of them silently no-ops.
    function test_handlerSmoke() public {
        h.buy(0, 0); // vids[0] -> purchase 1
        h.buy(1, 1); // vids[1] -> purchase 2
        h.buy(2, 0); // vids[2] -> purchase 3
        assertEq(h.bought(), 3);
        h.deliver(0);
        h.deliver(1);
        h.deliver(2);
        assertEq(h.delivered(), 3);
        h.disputeMech(1, 1, true); // purchase 2 -> dispute 1
        assertEq(h.mechOpened(), 1);
        h.resolveMech(0, true, 1);
        assertEq(h.mechResolved(), 1);
        h.juryCase(0, 1, 0x3F); // purchase 1, all seats reveal Uphold -> dispute 2
        assertEq(h.juryResolved(), 1);
        h.warp(900);
        h.finalize(2); // purchase 3
        assertEq(h.settled(), 1);
        _checkConservation();
        // round-1 no-quorum then round 2: needs a fresh delivered purchase
        h.buy(0, 1);
        h.deliver(3);
        h.juryCase(3, 1, 0x3F << 6); // round 1 nobody reveals, round 2 all Uphold
        assertEq(h.juryResolved(), 2);
        _checkConservation();
    }

    function invariant_reservedWithinTotal() public view {
        (uint256 t1, uint256 r1,) = V.sellerStake(seller);
        (uint256 t2, uint256 r2,) = V.sellerStake(seller2);
        assertLe(r1, t1);
        assertLe(r2, t2);
        // reserved collateral == Σ collateral of live purchases
        uint256 live1;
        uint256 live2;
        for (uint256 i = 1; i < market.nextPurchaseId(); ++i) {
            S.Purchase memory p = V.getPurchase(i);
            if (
                p.state == S.PurchaseState.Funded || p.state == S.PurchaseState.Delivered
                    || p.state == S.PurchaseState.Disputed
            ) {
                if (p.seller == seller) live1 += p.collateral;
                else live2 += p.collateral;
            }
        }
        assertEq(r1, live1, "seller reserved");
        assertEq(r2, live2, "seller2 reserved");
    }

    function invariant_settledSplitsPrice() public view {
        for (uint256 i = 1; i < market.nextPurchaseId(); ++i) {
            S.Purchase memory p = V.getPurchase(i);
            if (p.state == S.PurchaseState.Settled) {
                assertEq(uint256(p.sellerProceeds) + p.fee + p.refunded, p.price, "split");
                assertLe(p.refunded, uint256(p.price) * p.refundCapBps / 10_000, "cap");
            }
        }
    }
}
