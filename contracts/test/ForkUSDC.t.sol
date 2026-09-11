// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {EnvMarket} from "../src/EnvMarket.sol";
import {EnvMarketViews} from "../src/EnvMarketViews.sol";
import {EnvMarketStorage as S} from "../src/EnvMarketStorage.sol";
import {MarketParams} from "../script/MarketParams.sol";

interface IFiatToken {
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
}

/// Runs against a fork of Base mainnet with the REAL native USDC and the mainnet param set.
/// Skipped unless BASE_RPC is set:  BASE_RPC=https://mainnet.base.org forge test --match-contract ForkUSDC
contract ForkUSDCTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    bytes32 constant ENC = keccak256("enc");
    bytes32 constant CIPHER = keccak256("ciphertext");
    bytes32 constant BUNDLE = keccak256("bundle");

    bool forked;
    EnvMarket market;
    EnvMarketViews V;
    IERC20 usdc = IERC20(USDC);
    address seller = makeAddr("fork-seller");
    address buyer = makeAddr("fork-buyer");
    address operator = makeAddr("fork-tee-operator"); // preview fee recipient
    uint256 constant PREVIEW_FEE = 200_000; // 0.2 USDC seller-paid preview inference
    bytes32 constant QUOTE = keccak256("tee-quote");
    address signer;
    uint256 signerPk;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 8453, "BASE_RPC is not Base mainnet");
        forked = true;
        (signer, signerPk) = makeAddrAndKey("tee-signer"); // one address may hold all three roles
        market = new EnvMarket(usdc, address(new EnvMarketViews()), address(this), MarketParams.mainnet());
        V = EnvMarketViews(address(market));
        market.setRunner(signer, true);
        market.setRelay(signer, true);
        market.setVerifier(signer, true);
        market.setPreviewFeeRecipient(operator);
        market.setMinPreviewFee(50_000); // mainnet default 0.05 USDC
        deal(USDC, seller, 10e6);
        deal(USDC, buyer, 10e6);
        vm.prank(seller);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);
    }

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function _sig(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _listNoReport() internal returns (uint256 vid) {
        S.VersionInput memory v;
        v.bundleHash = BUNDLE;
        v.ciphertextHash = CIPHER;
        v.taskCount = 5;
        v.price = 500_000; // 0.5 USDC (5 USDC demo budget)
        v.collateral = 500_000; // >= caseFee 0.10 + 10% of price
        vm.prank(seller);
        vid = market.createListing(v);
    }

    function _attach(uint256 vid) internal {
        bytes32 rh = keccak256("report");
        market.attachReport(vid, rh, _sig(market.previewReportDigest(vid, BUNDLE, rh)));
    }

    function _listBuyDeliver() internal returns (uint256 pid) {
        uint256 vid = _listNoReport();
        vm.startPrank(seller);
        market.depositCollateral(500_000);
        market.requestPreview(vid, PREVIEW_FEE, QUOTE);
        vm.stopPrank();
        _attach(vid);
        vm.prank(buyer);
        pid = market.buy(vid, ENC, 500_000);
        bytes32 wk = keccak256("wk");
        market.recordDelivery(pid, CIPHER, wk, wk, _sig(market.deliveryReceiptDigest(pid, ENC, CIPHER, wk, wk)));
    }

    function _conserved() internal view {
        assertEq(
            usdc.balanceOf(address(market)),
            market.totalEscrow() + market.totalCollateral() + market.totalBonds() + market.totalJurorStake()
                + market.treasury() + market.reserve() + market.totalClaimable() + V.totalPreviewFees()
        );
    }

    /// Seller-paid preview at the 0.5-USDC listing scale: 0.2 USDC fee escrowed, released to the TEE
    /// operator on attachReport; a second version's fee is reclaimed after the timeout.
    function testForkSellerPaysPreviewWithRealUsdc() public onlyFork {
        uint256 vid = _listNoReport();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(S.PreviewFeeTooLow.selector, 40_000, 50_000));
        market.requestPreview(vid, 40_000, QUOTE);
        vm.prank(seller);
        market.requestPreview(vid, PREVIEW_FEE, QUOTE);
        assertEq(usdc.balanceOf(seller), 10e6 - PREVIEW_FEE);
        assertEq(V.totalPreviewFees(), PREVIEW_FEE);
        _conserved();
        _attach(vid);
        assertEq(market.claimable(operator), PREVIEW_FEE);
        assertEq(V.totalPreviewFees(), 0);
        vm.prank(operator);
        market.withdraw();
        assertEq(usdc.balanceOf(operator), PREVIEW_FEE);
        _conserved();

        uint256 vid2 = _listNoReport();
        vm.prank(seller);
        market.requestPreview(vid2, PREVIEW_FEE, QUOTE);
        vm.warp(block.timestamp + 3601);
        vm.prank(seller);
        market.reclaimPreviewFee(vid2);
        vm.prank(seller);
        market.withdraw();
        assertEq(usdc.balanceOf(seller), 10e6 - PREVIEW_FEE);
        _conserved();
    }

    function testForkTokenIsRealUsdc() public onlyFork {
        assertEq(IERC20Metadata(USDC).symbol(), "USDC");
        assertEq(IERC20Metadata(USDC).decimals(), 6);
    }

    function testForkHappyPathWithRealUsdc() public onlyFork {
        uint256 pid = _listBuyDeliver();
        vm.warp(V.getPurchase(pid).challengeDeadline + 1);
        market.finalize(pid);
        assertEq(market.claimable(seller), 490_000); // 0.5 - 2%
        vm.prank(seller);
        market.withdraw();
        assertEq(usdc.balanceOf(seller), 10e6 - PREVIEW_FEE - 500_000 + 490_000);
        assertEq(market.claimable(operator), PREVIEW_FEE);
        _conserved();
    }

    function testForkMechanicalUpheldWithMainnetParams() public onlyFork {
        uint256 pid = _listBuyDeliver();
        vm.prank(buyer);
        uint256 did = market.openDispute(pid, S.Ground.BrokenOrHashMismatch, 1, keccak256("ev"));
        (S.Dispute memory d,) = V.getDispute(did);
        assertEq(d.requested, 100_000); // 0.5 / 5 tasks
        assertEq(d.bond, 100_000); // clamp(0.1, 0.05, 0.5)
        bytes32 fh = keccak256("f");
        market.resolveMechanical(did, true, 1, fh, _sig(market.mechanicalFindingDigest(did, true, 1, fh)));
        assertEq(market.claimable(buyer), 200_000); // refund 0.1 + bond 0.1
        assertEq(market.claimable(seller), 392_000); // 0.4 retained - 2%
        assertEq(market.treasury(), 8_000 + 100_000); // fee + case fee
        assertEq(market.reserve(), 50_000); // 10% penalty
        (uint256 tot,,) = V.sellerStake(seller);
        assertEq(tot, 500_000 - 100_000 - 50_000);
        _conserved();
        vm.prank(buyer);
        market.withdraw();
        assertEq(usdc.balanceOf(buyer), 10e6 - 500_000 - 100_000 + 200_000);
        _conserved();
    }

    /// A USDC-blacklisted seller cannot brick settlement: finalize credits, only their own withdraw fails.
    function testForkBlacklistedRecipientDoesNotBrickSettlement() public onlyFork {
        uint256 pid = _listBuyDeliver();
        IFiatToken fiat = IFiatToken(USDC);
        vm.prank(fiat.blacklister());
        fiat.blacklist(seller);
        assertTrue(fiat.isBlacklisted(seller));
        vm.warp(V.getPurchase(pid).challengeDeadline + 1);
        market.finalize(pid); // succeeds
        assertEq(uint8(V.getPurchase(pid).state), uint8(S.PurchaseState.Settled));
        vm.prank(seller);
        vm.expectRevert();
        market.withdraw();
        assertEq(market.claimable(seller), 490_000); // still owed
        _conserved();
    }
}
