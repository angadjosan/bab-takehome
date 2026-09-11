// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnvMarketStorage} from "./EnvMarketStorage.sol";

/// @title EnvMarketViews — read-only functions of EnvMarket, split out for the EIP-170 size limit.
/// @notice Deployed once and referenced immutably by EnvMarket, whose `fallback()` delegatecalls it.
///         Call these functions ON THE ENVMARKET ADDRESS (the exported EnvMarket ABI includes them).
///         Called directly at this module's own address they only see empty storage.
///         Contains no state-changing code.
contract EnvMarketViews is EnvMarketStorage {
    // ================================================================== VIEWS
    function params() external view returns (Params memory) {
        return _params;
    }

    function getVersion(uint256 versionId) external view returns (VersionTerms memory) {
        return _versions[versionId];
    }

    function getPurchase(uint256 purchaseId) external view returns (Purchase memory) {
        return _purchases[purchaseId];
    }

    /// @return d the dispute; seats[0..2] = round-1 panel, seats[3..5] = round-2 panel (zero if unused)
    function getDispute(uint256 disputeId) external view returns (Dispute memory d, Seat[6] memory seats) {
        d = _disputes[disputeId];
        seats = _seats[disputeId];
    }

    function sellerStake(address seller) external view returns (uint256 total, uint256 reserved, uint256 available) {
        Stake storage s = _stakes[seller];
        total = s.total;
        reserved = s.reserved;
        available = total - reserved;
    }

    function jurorInfo(address juror)
        external
        view
        returns (bool approved, uint256 total, uint256 locked, uint256 free)
    {
        JurorInfo storage j = _jurors[juror];
        approved = j.approved;
        total = j.total;
        locked = j.locked;
        free = total - locked;
    }

    function jurorList() external view returns (address[] memory) {
        return _jurorList;
    }

    function versionStats(uint256 versionId) external view returns (VersionStats memory) {
        return _versionStats[versionId];
    }

    function sellerStats(address seller) external view returns (SellerStats memory) {
        return _sellerStats[seller];
    }

    function sellerScore(address seller)
        external
        view
        returns (uint256 qualifyingTx, bool eligible, uint256 weightedRatingSum, uint256 ratedRetained)
    {
        SellerStats storage s = _sellerStats[seller];
        qualifyingTx = s.qualifyingTx;
        eligible = qualifyingTx >= QUALIFYING_TX_THRESHOLD;
        weightedRatingSum = s.weightedRatingSum;
        ratedRetained = s.ratedRetained;
    }

    function listingVersionIds(uint256 listingId) external view returns (uint256[] memory) {
        return _listingVersions[listingId];
    }

    function listVersionIdsBySeller(address seller) external view returns (uint256[] memory) {
        return _sellerVersions[seller];
    }

    function listPurchaseIdsByBuyer(address buyer) external view returns (uint256[] memory) {
        return _buyerPurchases[buyer];
    }

    function listPurchaseIdsBySeller(address seller) external view returns (uint256[] memory) {
        return _sellerPurchases[seller];
    }

    /// @notice (requested refund, bond) a dispute over `taskMask` would currently have.
    function quoteDispute(uint256 purchaseId, uint256 taskMask)
        external
        view
        returns (uint256 requested, uint256 bond)
    {
        Purchase storage p = _purchases[purchaseId];
        if (p.state == PurchaseState.None) revert UnknownPurchase();
        return _quote(p, taskMask);
    }

    // ------------------------------------------------------ seller-paid previews
    /// @notice Preview payment record of a version. `paidAt == 0` = never requested. After a reclaim the
    ///         record keeps the reclaimed fee (a new request must pay at least that much) until re-requested.
    function previewInfo(uint256 versionId)
        external
        view
        returns (uint256 fee, uint256 paidAt, bytes32 quoteHash, bool released, bool reclaimed)
    {
        Preview storage pv = _previews[versionId];
        return (pv.fee, pv.paidAt, pv.quoteHash, pv.released, pv.reclaimed);
    }

    /// @notice Last second at which the seller may NOT yet reclaim (reclaim needs now > this); 0 if never paid.
    function previewDeadline(uint256 versionId) external view returns (uint256) {
        Preview storage pv = _previews[versionId];
        return pv.paidAt == 0 ? 0 : uint256(pv.paidAt) + pv.timeout;
    }

    function previewFeeRecipient() external view returns (address) {
        return _previewFeeRecipient;
    }

    function minPreviewFee() external view returns (uint256) {
        return _minPreviewFee;
    }

    function previewTimeout() external view returns (uint256) {
        return _previewTimeout;
    }

    /// @notice Accounting bucket: Σ preview fees held in escrow (requested, not yet released or reclaimed).
    function totalPreviewFees() external view returns (uint256) {
        return _totalPreviewFees;
    }

    function qualifyingTxThreshold() external pure returns (uint256) {
        return QUALIFYING_TX_THRESHOLD;
    }

    function seats() external pure returns (uint256) {
        return SEATS;
    }

    function _quote(Purchase storage p, uint256 taskMask) internal view returns (uint256 requested, uint256 bond) {
        uint256 cap = uint256(p.price) * p.refundCapBps / BPS;
        requested = _popcount(taskMask) * (uint256(p.price) / p.taskCount);
        if (requested > cap) requested = cap;
        bond = requested < p.bondFloor ? p.bondFloor : (requested > p.bondCap ? p.bondCap : requested);
    }

    function _popcount(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            x &= x - 1;
            c++;
        }
    }
}
