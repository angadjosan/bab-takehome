// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {EnvMarket} from "../src/EnvMarket.sol";
import {EnvMarketViews} from "../src/EnvMarketViews.sol";
import {EnvMarketStorage} from "../src/EnvMarketStorage.sol";
import {MarketParams} from "./MarketParams.sol";

/// @notice Deploys EnvMarketViews + EnvMarket (and TestUSDC on anvil only), wires roles and jurors.
/// Env (all optional except DEPLOYER_PK):
///   DEPLOYER_PK                         deployer key (becomes owner)
///   TOKEN_ADDR                          payment token; REQUIRED off-anvil (Base mainnet: native USDC)
///   PARAM_SET = demo | mainnet          default: mainnet on 8453, demo elsewhere
///   RUNNER_ADDR / RELAY_ADDR / VERIFIER_ADDR   comma-separated address lists
///   JUROR1_ADDR / JUROR2_ADDR / JUROR3_ADDR    approved as jurors
///   SELLER_ADDR, BUYER_ADDR, BUYER2_ADDR       (anvil only) receive 10,000 tUSDC demo balances
///   PREVIEW_FEE_RECIPIENT               TEE operator payout for seller-paid previews
///                                       (default: first RUNNER_ADDR, else the deployer)
///   MIN_PREVIEW_FEE                     base units; default 50000 (0.05 USDC) for mainnet params, 1e6 for demo
///   PREVIEW_TIMEOUT                     seconds before a seller may reclaim an unattached preview (default 3600)
/// Writes nothing to disk and prints no secrets; scripts/deploy.sh records deployments/<chainId>.json.
contract Deploy is Script {
    uint256 constant ANVIL_CHAIN_ID = 31337;
    uint256 constant DEMO_MINT = 10_000e6;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        address tokenAddr = _addr("TOKEN_ADDR");
        if (tokenAddr == address(0) && block.chainid != ANVIL_CHAIN_ID) {
            revert("TOKEN_ADDR is required off-anvil (TestUSDC is for local tests only)");
        }
        string memory set = vm.envOr("PARAM_SET", string(""));
        if (bytes(set).length == 0) set = block.chainid == 8453 ? "mainnet" : "demo";
        EnvMarketStorage.Params memory p;
        uint256 defaultMinPreviewFee;
        if (keccak256(bytes(set)) == keccak256("mainnet")) {
            p = MarketParams.mainnet();
            defaultMinPreviewFee = MarketParams.MAINNET_MIN_PREVIEW_FEE;
        } else if (keccak256(bytes(set)) == keccak256("demo")) {
            p = MarketParams.demo();
            defaultMinPreviewFee = MarketParams.DEMO_MIN_PREVIEW_FEE;
        } else {
            revert("PARAM_SET must be demo or mainnet");
        }

        address[] memory runners = _addrs("RUNNER_ADDR");
        address feeRecipient = _addr("PREVIEW_FEE_RECIPIENT");
        if (feeRecipient == address(0)) feeRecipient = runners.length > 0 ? runners[0] : deployer;
        uint256 minPreviewFee = vm.envOr("MIN_PREVIEW_FEE", defaultMinPreviewFee);
        uint256 previewTimeout = vm.envOr("PREVIEW_TIMEOUT", uint256(MarketParams.PREVIEW_TIMEOUT));
        require(minPreviewFee <= type(uint128).max, "MIN_PREVIEW_FEE too large");
        require(previewTimeout > 0 && previewTimeout <= type(uint32).max, "PREVIEW_TIMEOUT out of range");
        address[] memory relays = _addrs("RELAY_ADDR");
        address[] memory verifiers = _addrs("VERIFIER_ADDR");
        address[3] memory jurorAddrs = [_addr("JUROR1_ADDR"), _addr("JUROR2_ADDR"), _addr("JUROR3_ADDR")];

        vm.startBroadcast(pk);
        if (tokenAddr == address(0)) {
            TestUSDC t = new TestUSDC(deployer);
            tokenAddr = address(t);
            address[6] memory demo = [
                _addr("SELLER_ADDR"), _addr("BUYER_ADDR"), _addr("BUYER2_ADDR"), jurorAddrs[0], jurorAddrs[1], jurorAddrs[2]
            ];
            for (uint256 i; i < demo.length; ++i) {
                if (demo[i] != address(0)) t.mint(demo[i], DEMO_MINT);
            }
        }
        EnvMarketViews views = new EnvMarketViews();
        EnvMarket market = new EnvMarket(IERC20(tokenAddr), address(views), deployer, p);
        for (uint256 i; i < runners.length; ++i) market.setRunner(runners[i], true);
        for (uint256 i; i < relays.length; ++i) market.setRelay(relays[i], true);
        for (uint256 i; i < verifiers.length; ++i) market.setVerifier(verifiers[i], true);
        for (uint256 i; i < 3; ++i) {
            if (jurorAddrs[i] != address(0)) market.approveJuror(jurorAddrs[i], true);
        }
        if (feeRecipient != deployer) market.setPreviewFeeRecipient(feeRecipient);
        if (minPreviewFee != 0) market.setMinPreviewFee(uint128(minPreviewFee));
        if (previewTimeout != MarketParams.PREVIEW_TIMEOUT) market.setPreviewTimeout(uint32(previewTimeout));
        vm.stopBroadcast();

        console2.log("paramSet", set);
        console2.log("previewFeeRecipient", feeRecipient);
        console2.log("minPreviewFee", minPreviewFee);
        console2.log("previewTimeout", previewTimeout);
        console2.log("token", tokenAddr);
        console2.log("views", address(views));
        console2.log("market", address(market));
        console2.log("owner", deployer);
    }

    function _addr(string memory name) internal view returns (address) {
        string memory raw = vm.envOr(name, string(""));
        return bytes(raw).length == 0 ? address(0) : vm.parseAddress(raw);
    }

    function _addrs(string memory name) internal view returns (address[] memory out) {
        string memory raw = vm.envOr(name, string(""));
        if (bytes(raw).length == 0) return new address[](0);
        return vm.envAddress(name, ",");
    }
}
