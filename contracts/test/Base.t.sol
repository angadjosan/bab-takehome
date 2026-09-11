// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {EnvMarket} from "../src/EnvMarket.sol";
import {EnvMarketViews} from "../src/EnvMarketViews.sol";
import {EnvMarketStorage as S} from "../src/EnvMarketStorage.sol";

/// Shared fixture: demo params, actors, signing helpers and the conservation check.
abstract contract MarketBase is Test {
    uint256 constant U = 1e6; // 1 tUSDC

    TestUSDC token;
    EnvMarket market;
    EnvMarketViews V; // = EnvMarketViews(address(market)) — views are served via the fallback

    address seller = makeAddr("seller");
    address seller2 = makeAddr("seller2");
    address buyer = makeAddr("buyer");
    address buyer2 = makeAddr("buyer2");
    address runner;
    uint256 runnerPk;
    address relay;
    uint256 relayPk;
    address verifier;
    uint256 verifierPk;
    address mallory;
    uint256 malloryPk;
    address[] jurors;

    bytes32 constant ENC_KEY = keccak256("buyer-x25519-pubkey");
    bytes32 constant BUNDLE = keccak256("bundle");
    bytes32 constant CIPHER = keccak256("ciphertext");
    bytes32 constant REPORT = keccak256("report");

    function demoParams() internal pure returns (S.Params memory p) {
        p.challengeWindow = 300;
        p.deliveryWindow = 600;
        p.refundCapBps = 5000;
        p.penaltyThresholdBps = 500;
        p.penaltyBps = 1000;
        p.feeBps = 200;
        p.bondFloor = uint128(5 * U);
        p.bondCap = uint128(50 * U);
        p.caseFee = uint128(6 * U);
        p.participationFee = uint128(1 * U);
        p.jurorStake = uint128(20 * U);
        p.minoritySlashBps = 2000;
        p.nonRevealSlashBps = 5000;
        p.commitWindow = 180;
        p.revealWindow = 180;
        p.verifierTimeout = 1800;
    }

    function setUp() public virtual {
        (runner, runnerPk) = makeAddrAndKey("runner");
        (relay, relayPk) = makeAddrAndKey("relay");
        (verifier, verifierPk) = makeAddrAndKey("verifier");
        (mallory, malloryPk) = makeAddrAndKey("mallory");
        vm.warp(1_700_000_000);
        vm.roll(100);

        token = new TestUSDC(address(this));
        EnvMarketViews views = new EnvMarketViews();
        market = new EnvMarket(IERC20(address(token)), address(views), address(this), demoParams());
        V = EnvMarketViews(address(market));
        market.setRunner(runner, true);
        market.setRelay(relay, true);
        market.setVerifier(verifier, true);
    }

    // ------------------------------------------------------------ actors
    function _addJurors(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            address j = makeAddr(string.concat("juror", vm.toString(jurors.length + 1)));
            jurors.push(j);
            market.approveJuror(j, true);
            _fund(j, 40 * U);
            vm.prank(j);
            market.depositJurorStake(40 * U);
        }
    }

    function _fund(address who, uint256 amt) internal {
        token.mint(who, amt);
        vm.prank(who);
        token.approve(address(market), type(uint256).max);
    }

    // ---------------------------------------------------------- signing
    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _input(uint16 taskCount, uint128 price, uint128 collateral)
        internal
        pure
        returns (S.VersionInput memory v)
    {
        v.bundleHash = BUNDLE;
        v.ciphertextHash = CIPHER;
        v.imageDigest = keccak256("image");
        v.descriptionHash = keccak256("description");
        v.manifestHash = keccak256("manifest");
        v.licenseHash = keccak256("license");
        v.taskRoot = keccak256("taskRoot");
        v.auditRoot = keccak256("auditRoot");
        v.taskCount = taskCount;
        v.auditTaskCount = 3;
        v.price = price;
        v.collateral = collateral;
        v.uri = "https://tee.example/blobs/";
    }

    // ------------------------------------------------------------- flows
    function _list(address s, uint16 taskCount, uint128 price, uint128 collateral, uint256 deposit)
        internal
        returns (uint256 vid)
    {
        if (deposit > 0) {
            _fund(s, deposit);
            vm.prank(s);
            market.depositCollateral(deposit);
        }
        vm.prank(s);
        vid = market.createListing(_input(taskCount, price, collateral));
        market.attachReport(vid, REPORT, _sign(runnerPk, market.previewReportDigest(vid, BUNDLE, REPORT)));
    }

    function _listDefault() internal returns (uint256) {
        return _list(seller, 5, uint128(100 * U), uint128(100 * U), 100 * U);
    }

    function _buy(address b, uint256 vid) internal returns (uint256 pid) {
        uint256 price = V.getVersion(vid).price;
        _fund(b, price);
        vm.prank(b);
        pid = market.buy(vid, ENC_KEY, price);
    }

    function _deliver(uint256 pid) internal {
        bytes32 wk = keccak256(abi.encode("wrappedKey", pid));
        bytes32 wr = keccak256(abi.encode("wrapper", pid));
        bytes memory sig = _sign(relayPk, market.deliveryReceiptDigest(pid, ENC_KEY, CIPHER, wk, wr));
        market.recordDelivery(pid, CIPHER, wk, wr, sig);
    }

    function _delivered() internal returns (uint256 vid, uint256 pid) {
        vid = _listDefault();
        pid = _buy(buyer, vid);
        _deliver(pid);
    }

    function _dispute(uint256 pid, S.Ground g, uint256 mask) internal returns (uint256 did) {
        (, uint256 bond) = V.quoteDispute(pid, mask);
        address b = V.getPurchase(pid).buyer;
        _fund(b, bond);
        vm.prank(b);
        did = market.openDispute(pid, g, mask, keccak256("evidence"));
    }

    function _select(uint256 did) internal {
        (S.Dispute memory d,) = V.getDispute(did);
        vm.roll(uint256(d.selectionBlock) + 1);
        vm.setBlockhash(d.selectionBlock, keccak256(abi.encode("bh", d.selectionBlock)));
        vm.prevrandao(keccak256(abi.encode("randao", block.number)));
        market.selectJurors(did);
    }

    function _panel(uint256 did, uint8 round) internal view returns (address[3] memory out) {
        (, S.Seat[6] memory seats) = V.getDispute(did);
        uint256 base = (uint256(round) - 1) * 3;
        for (uint256 k; k < 3; ++k) {
            out[k] = seats[base + k].juror;
        }
    }

    function _salt(address j, uint256 did) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", j, did));
    }

    function _commit(uint256 did, uint8 round, address j, S.Verdict v) internal {
        bytes32 c = market.commitmentFor(did, round, v, _salt(j, did), j); // compute before prank
        vm.prank(j);
        market.commitVote(did, c);
    }

    function _reveal(uint256 did, address j, S.Verdict v) internal {
        vm.prank(j);
        market.revealVote(did, v, _salt(j, did));
    }

    function _mask(uint256 bits) internal pure returns (uint256) {
        return bits;
    }

    // ----------------------------------------------------- conservation
    /// token.balanceOf(market) == Σ escrow + Σ collateral + Σ open bonds + Σ juror stake
    ///                            + treasury + reserve + Σ claimable,
    /// and every bucket total equals an independent recomputation from per-record state.
    function _checkConservation() internal view {
        uint256 bal = token.balanceOf(address(market));
        uint256 buckets = market.totalEscrow() + market.totalCollateral() + market.totalBonds()
            + market.totalJurorStake() + market.treasury() + market.reserve() + market.totalClaimable();
        assertEq(bal, buckets, "conservation: balance != buckets");

        uint256 escrow;
        for (uint256 i = 1; i < market.nextPurchaseId(); ++i) {
            S.Purchase memory p = V.getPurchase(i);
            if (
                p.state == S.PurchaseState.Funded || p.state == S.PurchaseState.Delivered
                    || p.state == S.PurchaseState.Disputed
            ) escrow += p.price;
        }
        assertEq(escrow, market.totalEscrow(), "escrow recompute");

        uint256 bonds;
        for (uint256 i = 1; i < market.nextDisputeId(); ++i) {
            (S.Dispute memory d,) = V.getDispute(i);
            if (d.status != S.DisputeStatus.Resolved) bonds += d.bond;
        }
        assertEq(bonds, market.totalBonds(), "bonds recompute");

        (uint256 t1,,) = V.sellerStake(seller);
        (uint256 t2,,) = V.sellerStake(seller2);
        assertEq(t1 + t2, market.totalCollateral(), "collateral recompute");

        uint256 js;
        address[] memory jl = V.jurorList();
        for (uint256 i; i < jl.length; ++i) {
            (, uint256 tot, uint256 locked,) = V.jurorInfo(jl[i]);
            assertLe(locked, tot, "juror locked <= total");
            js += tot;
        }
        assertEq(js, market.totalJurorStake(), "juror stake recompute");

        uint256 cl = market.claimable(seller) + market.claimable(seller2) + market.claimable(buyer)
            + market.claimable(buyer2);
        for (uint256 i; i < jl.length; ++i) {
            cl += market.claimable(jl[i]);
        }
        assertEq(cl, market.totalClaimable(), "claimable recompute");
    }
}
