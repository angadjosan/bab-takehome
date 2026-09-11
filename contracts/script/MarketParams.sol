// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnvMarketStorage} from "../src/EnvMarketStorage.sol";

/// @notice Market-level parameter sets (amounts in 6-decimal token base units).
///         Per-listing price/collateral are seller inputs, not market params.
library MarketParams {
    /// Seller-paid preview config (outside Params; set with setMinPreviewFee / setPreviewTimeout).
    uint128 internal constant DEMO_MIN_PREVIEW_FEE = 1e6; // 1 tUSDC (anvil)
    uint128 internal constant MAINNET_MIN_PREVIEW_FEE = 50_000; // 0.05 USDC
    uint32 internal constant PREVIEW_TIMEOUT = 3600; // seller may reclaim an unattached preview after 1 h

    /// Demo table in docs/BUILD_SPEC.md (local anvil / TestUSDC).
    function demo() internal pure returns (EnvMarketStorage.Params memory p) {
        p = _common();
        p.bondFloor = 5e6; // 5
        p.bondCap = 50e6; // 50
        p.caseFee = 6e6; // 6
        p.participationFee = 1e6; // 1
        p.jurorStake = 20e6; // 20
    }

    /// Base mainnet (8453) with real USDC — "Mainnet params" in docs/BUILD_SPEC.md (5 USDC demo budget;
    /// listings priced 0.5 USDC with 0.5 collateral ≥ caseFee + 10% of price = 0.15).
    function mainnet() internal pure returns (EnvMarketStorage.Params memory p) {
        p = _common();
        p.bondFloor = 50_000; // 0.05 USDC
        p.bondCap = 500_000; // 0.50 USDC
        p.caseFee = 100_000; // 0.10 USDC
        p.participationFee = 20_000; // 0.02 USDC
        p.jurorStake = 250_000; // 0.25 USDC
    }

    function _common() private pure returns (EnvMarketStorage.Params memory p) {
        p.challengeWindow = 300;
        p.deliveryWindow = 600;
        p.refundCapBps = 5000;
        p.penaltyThresholdBps = 500;
        p.penaltyBps = 1000;
        p.feeBps = 200;
        p.minoritySlashBps = 2000;
        p.nonRevealSlashBps = 5000;
        p.commitWindow = 180;
        p.revealWindow = 180;
        p.verifierTimeout = 1800;
    }
}
