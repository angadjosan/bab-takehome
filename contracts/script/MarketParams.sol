// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnvMarketStorage} from "../src/EnvMarketStorage.sol";

/// @notice Market-level parameter sets (amounts in 6-decimal token base units).
///         Per-listing price/collateral are seller inputs, not market params.
library MarketParams {
    /// Demo table in docs/BUILD_SPEC.md (local anvil / TestUSDC).
    function demo() internal pure returns (EnvMarketStorage.Params memory p) {
        p = _common();
        p.bondFloor = 5e6; // 5
        p.bondCap = 50e6; // 50
        p.caseFee = 6e6; // 6
        p.participationFee = 1e6; // 1
        p.jurorStake = 20e6; // 20
    }

    /// Base mainnet (8453) with real USDC — "Mainnet params" in docs/BUILD_SPEC.md.
    function mainnet() internal pure returns (EnvMarketStorage.Params memory p) {
        p = _common();
        p.bondFloor = 250_000; // 0.25 USDC
        p.bondCap = 2e6; // 2 USDC
        p.caseFee = 300_000; // 0.30 USDC
        p.participationFee = 50_000; // 0.05 USDC
        p.jurorStake = 1e6; // 1 USDC
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
