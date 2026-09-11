// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnvMarketStorage} from "./EnvMarketStorage.sol";

/// @title EnvMarket — escrowed marketplace for RL environments with signed previews,
///        relay-signed delivery, bounded refunds, mechanical + juror disputes and reputation.
/// @notice See docs/BUILD_SPEC.md ("Contract") for the binding interface. Amounts are in the
///         token's base units (tUSDC, 6 decimals). The token is fixed at deployment.
contract EnvMarket is EnvMarketStorage, EIP712, Ownable {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------- constants
    bytes32 public constant PREVIEW_REPORT_TYPEHASH =
        keccak256("PreviewReport(uint256 versionId,bytes32 bundleHash,bytes32 reportHash)");
    bytes32 public constant DELIVERY_RECEIPT_TYPEHASH = keccak256(
        "DeliveryReceipt(uint256 purchaseId,bytes32 buyerEncPubKey,bytes32 ciphertextHash,bytes32 wrappedKeyHash,bytes32 wrapperHash)"
    );
    bytes32 public constant MECHANICAL_FINDING_TYPEHASH =
        keccak256("MechanicalFinding(uint256 disputeId,bool upheld,uint256 confirmedMask,bytes32 findingsHash)");

    // ------------------------------------------------------------------ state
    IERC20 public immutable token;
    /// @notice Read-only module (same storage layout) reached through `fallback()` via delegatecall.
    address public immutable viewsModule;

    // ----------------------------------------------------------------- events
    event ParamsUpdated(Params params);
    event RunnerSet(address indexed account, bool allowed);
    event RelaySet(address indexed account, bool allowed);
    event VerifierSet(address indexed account, bool allowed);

    event ListingCreated(uint256 indexed listingId, uint256 indexed versionId, address indexed seller);
    event VersionCreated(
        uint256 indexed listingId,
        uint256 indexed versionId,
        uint32 versionNo,
        bytes32 bundleHash,
        bytes32 descriptionHash,
        address seller,
        uint256 price,
        uint256 collateral
    );
    event VersionActiveSet(uint256 indexed versionId, bool active);
    event ReportAttached(uint256 indexed versionId, bytes32 reportHash, address indexed runner);
    event PreviewConfigUpdated(address recipient, uint256 minFee, uint32 timeout);
    event PreviewRequested(uint256 indexed versionId, address indexed seller, uint256 fee, bytes32 quoteHash);
    event PreviewFeeReleased(uint256 indexed versionId, address indexed recipient, uint256 fee);
    event PreviewFeeReclaimed(uint256 indexed versionId, address indexed seller, uint256 fee);

    event CollateralDeposited(address indexed seller, uint256 amount);
    event CollateralWithdrawn(address indexed seller, uint256 amount);

    event Purchased(
        uint256 indexed purchaseId,
        uint256 indexed versionId,
        address indexed buyer,
        uint256 price,
        bytes32 buyerEncPubKey,
        uint64 deliveryDeadline,
        address seller,
        uint256 collateral
    );
    event Delivered(
        uint256 indexed purchaseId,
        bytes32 ciphertextHash,
        bytes32 wrappedKeyHash,
        bytes32 wrapperHash,
        uint64 challengeDeadline,
        address relay
    );
    event RefundedUndelivered(uint256 indexed purchaseId, address indexed buyer, uint256 amount);

    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed purchaseId,
        Ground ground,
        uint256 taskMask,
        uint256 requested,
        uint256 bond,
        bytes32 evidenceHash
    );
    event SelectionArmed(uint256 indexed disputeId, uint8 round, uint64 selectionBlock);
    event JurorsSelected(
        uint256 indexed disputeId,
        uint8 round,
        address[3] jurors,
        uint64 commitDeadline,
        uint64 revealDeadline,
        bytes32 seed
    );
    event VoteCommitted(uint256 indexed disputeId, uint8 round, address indexed juror);
    event VoteRevealed(uint256 indexed disputeId, uint8 round, address indexed juror, Verdict verdict);
    event JurorPaid(uint256 indexed disputeId, uint8 round, address indexed juror, uint256 amount);
    event JurorSlashed(uint256 indexed disputeId, uint8 round, address indexed juror, uint256 amount, bool nonReveal);
    event RoundFailed(uint256 indexed disputeId, uint8 round, uint256 reveals);
    event FallbackNoQuorum(uint256 indexed disputeId, uint256 indexed purchaseId);
    event VerifierTimeout(uint256 indexed disputeId, uint256 indexed purchaseId);
    event MechanicalResolved(
        uint256 indexed disputeId, bool upheld, uint256 confirmedMask, bytes32 findingsHash, address verifier
    );
    event DisputeResolved(
        uint256 indexed disputeId, Verdict verdict, uint256 refund, uint256 sellerProceeds, uint256 penalties
    );
    event PurchaseSettled(uint256 indexed purchaseId, uint256 sellerProceeds, uint256 refund, uint256 fee);

    event Rated(
        uint256 indexed purchaseId, uint256 indexed versionId, address indexed seller, uint8 stars, bytes32 commentHash
    );
    event JurorRegistered(address indexed juror, bool approved);
    event JurorStakeChanged(address indexed juror, uint256 total, uint256 locked);
    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event ReserveWithdrawn(address indexed to, uint256 amount);

    // ------------------------------------------------------------ constructor
    constructor(IERC20 token_, address views_, address initialOwner, Params memory p)
        EIP712("EnvMarket", "1")
        Ownable(initialOwner)
    {
        token = token_;
        viewsModule = views_;
        _setParams(p);
        _setPreviewConfig(initialOwner, 0, 3600);
    }

    // =================================================================== ADMIN
    function setParams(Params calldata p) external onlyOwner {
        _setParams(p);
    }

    function _setParams(Params memory p) internal {
        if (
            p.refundCapBps > BPS || p.penaltyThresholdBps > BPS || p.penaltyBps > BPS || p.feeBps > BPS
                || p.minoritySlashBps > BPS || p.nonRevealSlashBps > BPS || p.bondFloor > p.bondCap
                || p.challengeWindow == 0 || p.deliveryWindow == 0 || p.commitWindow == 0 || p.revealWindow == 0
                || p.verifierTimeout == 0 || p.jurorStake == 0 || uint256(p.participationFee) * SEATS > p.caseFee
        ) revert InvalidParams();
        _params = p;
        emit ParamsUpdated(p);
    }

    /// @notice Where released preview fees are credited (the TEE operator's payout address).
    function setPreviewFeeRecipient(address recipient) external onlyOwner {
        _setPreviewConfig(recipient, _minPreviewFee, _previewTimeout);
    }

    /// @notice Minimum fee for FUTURE `requestPreview` calls (already-paid previews are unaffected).
    function setMinPreviewFee(uint128 minFee) external onlyOwner {
        _setPreviewConfig(_previewFeeRecipient, minFee, _previewTimeout);
    }

    /// @notice Reclaim delay for FUTURE `requestPreview` calls (each request snapshots its own).
    function setPreviewTimeout(uint32 timeout) external onlyOwner {
        _setPreviewConfig(_previewFeeRecipient, _minPreviewFee, timeout);
    }

    function _setPreviewConfig(address recipient, uint128 minFee, uint32 timeout) internal {
        if (recipient == address(0) || timeout == 0) revert InvalidParams();
        _previewFeeRecipient = recipient;
        _minPreviewFee = minFee;
        _previewTimeout = timeout;
        emit PreviewConfigUpdated(recipient, minFee, timeout);
    }

    function setRunner(address a, bool allowed) external onlyOwner {
        isRunner[a] = allowed;
        emit RunnerSet(a, allowed);
    }

    function setRelay(address a, bool allowed) external onlyOwner {
        isRelay[a] = allowed;
        emit RelaySet(a, allowed);
    }

    function setVerifier(address a, bool allowed) external onlyOwner {
        isVerifier[a] = allowed;
        emit VerifierSet(a, allowed);
    }

    function approveJuror(address juror, bool approved) external onlyOwner {
        JurorInfo storage j = _jurors[juror];
        if (!j.listed) {
            if (_jurorList.length >= MAX_JURORS) revert TooManyJurors();
            j.listed = true;
            _jurorList.push(juror);
        }
        j.approved = approved;
        emit JurorRegistered(juror, approved);
    }

    function withdrawTreasury(address to, uint256 amount) external onlyOwner {
        if (amount > treasury) revert InsufficientFunds();
        treasury -= amount;
        token.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    function withdrawReserve(address to, uint256 amount) external onlyOwner {
        if (amount > reserve) revert InsufficientFunds();
        reserve -= amount;
        token.safeTransfer(to, amount);
        emit ReserveWithdrawn(to, amount);
    }

    // ========================================================= PULL PAYMENTS
    /// @notice Withdraw the caller's whole claimable balance (refunds, bonds, proceeds, juror rewards).
    function withdraw() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert ZeroValue();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ======================================================= LISTINGS/VERSIONS
    function createListing(VersionInput calldata v) external returns (uint256 versionId) {
        uint256 listingId = nextListingId++;
        listingSeller[listingId] = msg.sender;
        emit ListingCreated(listingId, nextVersionId, msg.sender);
        versionId = _addVersion(listingId, v);
    }

    function newVersion(uint64 listingId, VersionInput calldata v) external returns (uint256 versionId) {
        address s = listingSeller[listingId];
        if (s == address(0)) revert UnknownListing();
        if (s != msg.sender) revert Unauthorized();
        versionId = _addVersion(listingId, v);
    }

    function _addVersion(uint256 listingId, VersionInput calldata v) internal returns (uint256 versionId) {
        Params storage pr = _params;
        uint32 cw = v.challengeWindow == 0 ? pr.challengeWindow : v.challengeWindow;
        uint32 dw = v.deliveryWindow == 0 ? pr.deliveryWindow : v.deliveryWindow;
        if (
            v.taskCount == 0 || v.taskCount > 256 || v.price == 0 || v.bundleHash == 0 || v.ciphertextHash == 0
                || cw < pr.challengeWindow || dw > pr.deliveryWindow
        ) revert InvalidTerms();

        versionId = nextVersionId++;
        uint256[] storage lv = _listingVersions[listingId];
        lv.push(versionId);
        _sellerVersions[msg.sender].push(versionId);

        VersionTerms storage t = _versions[versionId];
        t.seller = msg.sender;
        t.listingId = uint64(listingId);
        t.versionNo = uint32(lv.length);
        t.bundleHash = v.bundleHash;
        t.ciphertextHash = v.ciphertextHash;
        t.imageDigest = v.imageDigest;
        t.descriptionHash = v.descriptionHash;
        t.manifestHash = v.manifestHash;
        t.licenseHash = v.licenseHash;
        t.taskRoot = v.taskRoot;
        t.auditRoot = v.auditRoot;
        t.taskCount = v.taskCount;
        t.auditTaskCount = v.auditTaskCount;
        t.price = v.price;
        t.collateral = v.collateral;
        t.deliveryWindow = dw;
        t.challengeWindow = cw;
        t.uri = v.uri;
        t.active = true;

        emit VersionCreated(
            listingId, versionId, t.versionNo, v.bundleHash, v.descriptionHash, msg.sender, v.price, v.collateral
        );
    }

    function setVersionActive(uint256 versionId, bool active) external {
        VersionTerms storage t = _versions[versionId];
        if (t.seller == address(0)) revert UnknownVersion();
        if (t.seller != msg.sender) revert Unauthorized();
        t.active = active;
        emit VersionActiveSet(versionId, active);
    }

    // ------------------------------------------------------ seller-paid previews
    /// @notice Seller escrows the preview inference fee (reference-model episodes + validator, run by
    ///         the TEE). Must precede `attachReport`. `quoteHash` = sha256 of the TEE's signed quote JSON;
    ///         the TEE only runs once the on-chain fee is >= its quote.
    function requestPreview(uint256 versionId, uint256 fee, bytes32 quoteHash) external {
        VersionTerms storage t = _versions[versionId];
        if (t.seller == address(0)) revert UnknownVersion();
        if (t.seller != msg.sender) revert Unauthorized();
        if (t.reportHash != 0) revert ReportAlreadyAttached();
        Preview storage pv = _previews[versionId];
        if (pv.paidAt != 0 && !pv.reclaimed) revert PreviewAlreadyPaid();
        // Report signatures do not bind the fee, so after a reclaim the next request must pay at least
        // the reclaimed fee: a seller cannot reclaim, re-request at the minimum and attach a report the
        // TEE already produced for the higher quote.
        uint256 minFee = _minPreviewFee;
        if (pv.reclaimed && pv.fee > minFee) minFee = pv.fee;
        if (fee < minFee) revert PreviewFeeTooLow(fee, minFee);
        pv.fee = SafeCast.toUint128(fee);
        pv.paidAt = uint64(block.timestamp);
        pv.timeout = _previewTimeout;
        pv.reclaimed = false;
        pv.quoteHash = quoteHash;
        _totalPreviewFees += fee;
        if (fee != 0) token.safeTransferFrom(msg.sender, address(this), fee);
        emit PreviewRequested(versionId, msg.sender, fee, quoteHash);
    }

    /// @notice Seller refund of an escrowed preview fee when no report was attached within the
    ///         request's timeout. The version may `requestPreview` again afterwards.
    function reclaimPreviewFee(uint256 versionId) external {
        VersionTerms storage t = _versions[versionId];
        if (t.seller == address(0)) revert UnknownVersion();
        if (t.seller != msg.sender) revert Unauthorized();
        if (t.reportHash != 0) revert ReportAlreadyAttached();
        Preview storage pv = _previews[versionId];
        if (pv.paidAt == 0 || pv.reclaimed) revert PreviewNotPaid();
        if (block.timestamp <= uint256(pv.paidAt) + pv.timeout) revert DeadlineNotPassed();
        pv.reclaimed = true;
        uint256 fee = pv.fee;
        _totalPreviewFees -= fee;
        emit PreviewFeeReclaimed(versionId, msg.sender, fee);
        _credit(msg.sender, fee);
    }

    /// @notice Anyone submits; sig by a runner; once per version; requires an outstanding paid preview,
    ///         whose fee is released to `previewFeeRecipient`.
    function attachReport(uint256 versionId, bytes32 reportHash, bytes calldata runnerSig) external {
        VersionTerms storage t = _versions[versionId];
        if (t.seller == address(0)) revert UnknownVersion();
        if (t.reportHash != 0) revert ReportAlreadyAttached();
        if (reportHash == 0) revert ZeroValue();
        Preview storage pv = _previews[versionId];
        if (pv.paidAt == 0 || pv.reclaimed) revert PreviewNotPaid();
        address signer = _recover(previewReportDigest(versionId, t.bundleHash, reportHash), runnerSig);
        if (!isRunner[signer]) revert BadSignature();
        t.reportHash = reportHash;
        pv.released = true;
        uint256 fee = pv.fee;
        _totalPreviewFees -= fee;
        address recipient = _previewFeeRecipient;
        emit ReportAttached(versionId, reportHash, signer);
        emit PreviewFeeReleased(versionId, recipient, fee);
        _credit(recipient, fee);
    }

    // ============================================================= COLLATERAL
    function depositCollateral(uint256 amount) external {
        if (amount == 0) revert ZeroValue();
        _stakes[msg.sender].total += SafeCast.toUint128(amount);
        totalCollateral += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external {
        Stake storage s = _stakes[msg.sender];
        uint256 avail = s.total - s.reserved;
        if (amount == 0) revert ZeroValue();
        if (amount > avail) revert InsufficientCollateral(avail, amount);
        s.total -= uint128(amount);
        totalCollateral -= amount;
        token.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    // ============================================================== PURCHASES
    function buy(uint256 versionId, bytes32 buyerEncPubKey, uint256 maxPrice) external returns (uint256 purchaseId) {
        VersionTerms storage t = _versions[versionId];
        if (t.seller == address(0)) revert UnknownVersion();
        if (!t.active) revert VersionInactive();
        if (t.reportHash == 0) revert ReportMissing();
        if (msg.sender == t.seller) revert SelfPurchase();
        if (buyerEncPubKey == 0) revert ZeroValue();
        uint256 price = t.price;
        if (price > maxPrice) revert PriceAboveMax(price, maxPrice);

        Params storage pr = _params;
        uint256 collateral = t.collateral;
        // Collateral must cover the worst-case seller-side dispute charge (case fee + extra penalty).
        uint256 required = uint256(pr.caseFee) + price * pr.penaltyBps / BPS;
        if (collateral < required) revert CollateralBelowRequirement(collateral, required);
        Stake storage s = _stakes[t.seller];
        uint256 avail = s.total - s.reserved;
        if (avail < collateral) revert InsufficientCollateral(avail, collateral);
        s.reserved += uint128(collateral);

        purchaseId = nextPurchaseId++;
        Purchase storage p = _purchases[purchaseId];
        p.versionId = versionId;
        p.buyer = msg.sender;
        p.seller = t.seller;
        p.state = PurchaseState.Funded;
        p.price = uint128(price);
        p.collateral = uint128(collateral);
        p.buyerEncPubKey = buyerEncPubKey;
        p.fundedAt = uint64(block.timestamp);
        p.deliveryDeadline = uint64(block.timestamp + t.deliveryWindow);
        p.challengeWindow = t.challengeWindow;
        p.taskCount = t.taskCount;
        p.feeBps = pr.feeBps;
        p.refundCapBps = pr.refundCapBps;
        p.penaltyThresholdBps = pr.penaltyThresholdBps;
        p.penaltyBps = pr.penaltyBps;
        p.bondFloor = pr.bondFloor;
        p.bondCap = pr.bondCap;
        p.caseFee = pr.caseFee;

        _buyerPurchases[msg.sender].push(purchaseId);
        _sellerPurchases[t.seller].push(purchaseId);
        totalEscrow += price;

        token.safeTransferFrom(msg.sender, address(this), price);
        emit Purchased(
            purchaseId, versionId, msg.sender, price, buyerEncPubKey, p.deliveryDeadline, t.seller, collateral
        );
    }

    function recordDelivery(
        uint256 purchaseId,
        bytes32 ciphertextHash,
        bytes32 wrappedKeyHash,
        bytes32 wrapperHash,
        bytes calldata relaySig
    ) external {
        Purchase storage p = _purchases[purchaseId];
        if (p.state != PurchaseState.Funded) revert WrongState();
        if (block.timestamp > p.deliveryDeadline) revert DeadlinePassed();
        if (ciphertextHash != _versions[p.versionId].ciphertextHash) revert CiphertextMismatch();
        address signer = _recover(
            deliveryReceiptDigest(purchaseId, p.buyerEncPubKey, ciphertextHash, wrappedKeyHash, wrapperHash), relaySig
        );
        if (!isRelay[signer]) revert BadSignature();

        p.state = PurchaseState.Delivered;
        p.ciphertextHash = ciphertextHash;
        p.wrappedKeyHash = wrappedKeyHash;
        p.wrapperHash = wrapperHash;
        p.relay = signer;
        p.deliveredAt = uint64(block.timestamp);
        p.challengeDeadline = uint64(block.timestamp + p.challengeWindow);
        emit Delivered(purchaseId, ciphertextHash, wrappedKeyHash, wrapperHash, p.challengeDeadline, signer);
    }

    function refundUndelivered(uint256 purchaseId) external {
        Purchase storage p = _purchases[purchaseId];
        if (p.state != PurchaseState.Funded) revert WrongState();
        if (block.timestamp <= p.deliveryDeadline) revert DeadlineNotPassed();
        p.state = PurchaseState.Refunded;
        p.refunded = p.price;
        p.settledAt = uint64(block.timestamp);
        _stakes[p.seller].reserved -= p.collateral;
        totalEscrow -= p.price;
        _sellerStats[p.seller].fullRefunds++;
        emit RefundedUndelivered(purchaseId, p.buyer, p.price);
        _credit(p.buyer, p.price);
    }

    function finalize(uint256 purchaseId) external {
        Purchase storage p = _purchases[purchaseId];
        if (p.state != PurchaseState.Delivered) revert WrongState();
        if (block.timestamp <= p.challengeDeadline) revert DeadlineNotPassed();
        _stakes[p.seller].reserved -= p.collateral;
        _closePurchase(purchaseId, p, 0);
    }

    // =============================================================== DISPUTES
    function openDispute(uint256 purchaseId, Ground ground, uint256 taskMask, bytes32 evidenceHash)
        external
        returns (uint256 disputeId)
    {
        Purchase storage p = _purchases[purchaseId];
        if (msg.sender != p.buyer) revert Unauthorized();
        if (p.state != PurchaseState.Delivered) revert WrongState();
        if (block.timestamp > p.challengeDeadline) revert DeadlinePassed();
        if (ground == Ground.None) revert BadGround();
        if (taskMask == 0 || (p.taskCount < 256 && (taskMask >> p.taskCount) != 0)) revert BadMask();
        (uint256 requested, uint256 bond) = _quote(p, taskMask);

        disputeId = nextDisputeId++;
        p.state = PurchaseState.Disputed;
        p.disputeId = disputeId;

        Params storage pr = _params;
        Dispute storage d = _disputes[disputeId];
        d.purchaseId = purchaseId;
        d.ground = ground;
        d.taskMask = taskMask;
        d.evidenceHash = evidenceHash;
        d.requested = uint128(requested);
        d.bond = uint128(bond);
        d.caseFee = p.caseFee;
        d.participationFee = pr.participationFee;
        d.jurorStake = pr.jurorStake;
        d.minoritySlashBps = pr.minoritySlashBps;
        d.nonRevealSlashBps = pr.nonRevealSlashBps;
        d.commitWindow = pr.commitWindow;
        d.revealWindow = pr.revealWindow;
        d.openedAt = uint64(block.timestamp);
        if (ground == Ground.FalseDescription) {
            d.status = DisputeStatus.AwaitingSelection;
            d.round = 1;
            _armSelection(disputeId, d);
        } else {
            d.status = DisputeStatus.Voting; // "under review" by the mechanical verifier
            d.verifierDeadline = uint64(block.timestamp + pr.verifierTimeout);
        }

        totalBonds += bond;
        _versionStats[p.versionId].disputesOpened++;
        _sellerStats[p.seller].disputesOpened++;

        token.safeTransferFrom(msg.sender, address(this), bond);
        emit DisputeOpened(disputeId, purchaseId, ground, taskMask, requested, bond, evidenceHash);
    }

    function resolveMechanical(
        uint256 disputeId,
        bool upheld,
        uint256 confirmedMask,
        bytes32 findingsHash,
        bytes calldata verifierSig
    ) external {
        Dispute storage d = _disputes[disputeId];
        if (d.ground != Ground.BrokenOrHashMismatch && d.ground != Ground.PreviewNotReproducible) revert BadGround();
        if (d.status != DisputeStatus.Voting) revert WrongState();
        if (upheld ? (confirmedMask == 0 || (confirmedMask & ~d.taskMask) != 0) : confirmedMask != 0) {
            revert BadMask();
        }
        address signer =
            _recover(mechanicalFindingDigest(disputeId, upheld, confirmedMask, findingsHash), verifierSig);
        if (!isVerifier[signer]) revert BadSignature();
        d.findingsHash = findingsHash;
        emit MechanicalResolved(disputeId, upheld, confirmedMask, findingsHash, signer);
        uint256 caseFeePaid = _resolve(disputeId, d, upheld, confirmedMask);
        treasury += caseFeePaid; // verifier operator cost
    }

    /// @notice Mechanical dispute not resolved by the verifier before `verifierDeadline`:
    ///         precommitted no-fault fallback (bond returned, no refund, purchase settles normally).
    function timeoutMechanical(uint256 disputeId) external {
        Dispute storage d = _disputes[disputeId];
        if (d.ground != Ground.BrokenOrHashMismatch && d.ground != Ground.PreviewNotReproducible) revert BadGround();
        if (d.status != DisputeStatus.Voting) revert WrongState();
        if (block.timestamp <= d.verifierDeadline) revert DeadlineNotPassed();
        emit VerifierTimeout(disputeId, d.purchaseId);
        _resolveFallback(disputeId, d);
    }

    // ----------------------------------------------------------------- jurors
    function depositJurorStake(uint256 amount) external {
        JurorInfo storage j = _jurors[msg.sender];
        if (!j.approved) revert JurorNotApproved();
        if (amount == 0) revert ZeroValue();
        j.total += SafeCast.toUint128(amount);
        j.stakeBlock = uint64(block.number);
        totalJurorStake += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit JurorStakeChanged(msg.sender, j.total, j.locked);
    }

    function withdrawJurorStake(uint256 amount) external {
        JurorInfo storage j = _jurors[msg.sender];
        uint256 free = j.total - j.locked;
        if (amount == 0) revert ZeroValue();
        if (amount > free) revert InsufficientStake(free, amount);
        j.total -= uint128(amount);
        totalJurorStake -= amount;
        token.safeTransfer(msg.sender, amount);
        emit JurorStakeChanged(msg.sender, j.total, j.locked);
    }

    /// @notice Draw the panel for the current round from `blockhash(selectionBlock)` and `block.prevrandao`.
    function selectJurors(uint256 disputeId) external {
        Dispute storage d = _disputes[disputeId];
        if (d.ground != Ground.FalseDescription || d.status != DisputeStatus.AwaitingSelection) revert WrongState();
        if (block.number <= d.selectionBlock) revert TooEarly();
        bytes32 bh = blockhash(d.selectionBlock);
        if (bh == 0) {
            // selection block older than 256 blocks: re-arm with a fresh future block. The grace
            // deadline is NOT moved, so an unfillable panel still fails over (no permanent lock).
            d.selectionBlock = uint64(block.number + 2);
            emit SelectionArmed(disputeId, d.round, d.selectionBlock);
            return;
        }
        bytes32 seed = keccak256(abi.encode(bh, block.prevrandao, disputeId, d.round));

        // Each eligible juror draws r = keccak256(seed, juror); the 3 lowest draws are seated. A juror's
        // seat depends only on their own draw, so toggling one's own eligibility cannot re-roll others.
        Purchase storage p = _purchases[d.purchaseId];
        Seat[6] storage seats = _seats[disputeId];
        uint256 n = _jurorList.length;
        address[3] memory chosen;
        uint256[3] memory best = [type(uint256).max, type(uint256).max, type(uint256).max];
        uint256 count;
        for (uint256 i; i < n; ++i) {
            address a = _jurorList[i];
            JurorInfo storage j = _jurors[a];
            if (!j.approved || j.total - j.locked < d.jurorStake || a == p.buyer || a == p.seller) continue;
            // stake added once blockhash(selectionBlock) could be known does not count for this draw
            if (j.stakeBlock > d.selectionBlock) continue;
            if (d.round == 2 && (a == seats[0].juror || a == seats[1].juror || a == seats[2].juror)) continue;
            count++;
            uint256 r = uint256(keccak256(abi.encode(seed, a)));
            if (r >= best[2]) continue;
            uint256 k = 2;
            while (k > 0 && r < best[k - 1]) {
                best[k] = best[k - 1];
                chosen[k] = chosen[k - 1];
                --k;
            }
            best[k] = r;
            chosen[k] = a;
        }
        if (count < SEATS) {
            if (block.timestamp <= d.selectionDeadline) revert NotEnoughJurors();
            // Panel cannot be filled within the grace period: counts as a failed round.
            emit RoundFailed(disputeId, d.round, 0);
            _advanceOrFallback(disputeId, d);
            return;
        }

        uint256 base = (uint256(d.round) - 1) * SEATS;
        for (uint256 k; k < SEATS; ++k) {
            address a = chosen[k];
            seats[base + k].juror = a;
            JurorInfo storage j = _jurors[a];
            j.locked += d.jurorStake;
            emit JurorStakeChanged(a, j.total, j.locked);
        }
        d.status = DisputeStatus.Voting;
        d.commitDeadline = uint64(block.timestamp + d.commitWindow);
        d.revealDeadline = d.commitDeadline + d.revealWindow;
        emit JurorsSelected(disputeId, d.round, chosen, d.commitDeadline, d.revealDeadline, seed);
    }

    function commitVote(uint256 disputeId, bytes32 commitment) external {
        Dispute storage d = _disputes[disputeId];
        if (d.ground != Ground.FalseDescription || d.status != DisputeStatus.Voting) revert WrongState();
        if (block.timestamp > d.commitDeadline) revert DeadlinePassed();
        if (commitment == 0) revert ZeroValue();
        Seat storage s = _seats[disputeId][_seatIndex(disputeId, d.round, msg.sender)];
        if (s.commitment != 0) revert AlreadyCommitted();
        s.commitment = commitment;
        emit VoteCommitted(disputeId, d.round, msg.sender);
    }

    /// @notice Reveal opens after `commitDeadline`, or as soon as every seat of the round has committed.
    function revealVote(uint256 disputeId, Verdict verdict, bytes32 salt) external {
        Dispute storage d = _disputes[disputeId];
        if (d.ground != Ground.FalseDescription || d.status != DisputeStatus.Voting) revert WrongState();
        if (block.timestamp > d.revealDeadline) revert DeadlinePassed();
        if (block.timestamp <= d.commitDeadline && !_allCommitted(disputeId, d.round)) revert TooEarly();
        if (verdict != Verdict.Uphold && verdict != Verdict.Reject) revert BadVerdict();
        Seat storage s = _seats[disputeId][_seatIndex(disputeId, d.round, msg.sender)];
        if (s.commitment == 0) revert NotCommitted();
        if (s.revealed) revert AlreadyRevealed();
        if (commitmentFor(disputeId, d.round, verdict, salt, msg.sender) != s.commitment) revert CommitmentMismatch();
        s.revealed = true;
        s.vote = verdict;
        emit VoteRevealed(disputeId, d.round, msg.sender, verdict);
    }

    function tallyDispute(uint256 disputeId) external {
        Dispute storage d = _disputes[disputeId];
        if (d.ground != Ground.FalseDescription || d.status != DisputeStatus.Voting) revert WrongState();
        Seat[6] storage seats = _seats[disputeId];
        uint8 round = d.round;
        uint256 base = (uint256(round) - 1) * SEATS;
        uint256 reveals;
        uint256 ups;
        for (uint256 k; k < SEATS; ++k) {
            Seat storage s = seats[base + k];
            if (s.revealed) {
                reveals++;
                if (s.vote == Verdict.Uphold) ups++;
            }
        }
        if (block.timestamp <= d.revealDeadline && reveals < SEATS) revert TooEarly();
        uint256 rejects = reveals - ups;

        // Non-revealers lose nonRevealSlashBps of their seat stake to the reserve.
        uint256 nrSlash = uint256(d.jurorStake) * d.nonRevealSlashBps / BPS;
        for (uint256 k; k < SEATS; ++k) {
            Seat storage s = seats[base + k];
            if (!s.revealed) {
                JurorInfo storage j = _jurors[s.juror];
                j.total -= uint128(nrSlash);
                j.locked -= d.jurorStake;
                s.slashed = uint128(nrSlash);
                totalJurorStake -= nrSlash;
                reserve += nrSlash;
                emit JurorSlashed(disputeId, round, s.juror, nrSlash, true);
                emit JurorStakeChanged(s.juror, j.total, j.locked);
            }
        }

        if (reveals >= 2 && ups != rejects) {
            bool upheld = ups > rejects;
            uint256 pot = _resolve(disputeId, d, upheld, upheld ? d.taskMask : 0);
            _payJurors(disputeId, d, base, upheld ? Verdict.Uphold : Verdict.Reject, pot, reveals);
        } else {
            for (uint256 k; k < SEATS; ++k) {
                Seat storage s = seats[base + k];
                if (s.revealed) {
                    JurorInfo storage j = _jurors[s.juror];
                    j.locked -= d.jurorStake;
                    emit JurorStakeChanged(s.juror, j.total, j.locked);
                }
            }
            emit RoundFailed(disputeId, round, reveals);
            _advanceOrFallback(disputeId, d);
        }
    }

    // ============================================================= REPUTATION
    function rate(uint256 purchaseId, uint8 stars, bytes32 commentHash) external {
        Purchase storage p = _purchases[purchaseId];
        if (msg.sender != p.buyer) revert Unauthorized();
        if (p.state != PurchaseState.Settled || p.deliveredAt == 0) revert NotEligible();
        if (p.rated) revert AlreadyRated();
        if (stars < 1 || stars > 5) revert BadStars();
        p.rated = true;
        p.stars = stars;
        VersionStats storage vs = _versionStats[p.versionId];
        vs.ratingSum += stars;
        vs.ratingCount++;
        uint256 retained = uint256(p.price) - p.refunded;
        SellerStats storage ss = _sellerStats[p.seller];
        ss.weightedRatingSum += retained * stars;
        ss.ratedRetained += retained;
        emit Rated(purchaseId, p.versionId, p.seller, stars, commentHash);
    }

    // =============================================================== INTERNAL
    function _armSelection(uint256 disputeId, Dispute storage d) internal {
        d.selectionBlock = uint64(block.number + 2);
        d.selectionDeadline = uint64(block.timestamp + d.commitWindow + d.revealWindow);
        emit SelectionArmed(disputeId, d.round, d.selectionBlock);
    }

    function _advanceOrFallback(uint256 disputeId, Dispute storage d) internal {
        if (d.round == 1) {
            d.round = 2;
            d.status = DisputeStatus.AwaitingSelection;
            d.commitDeadline = 0;
            d.revealDeadline = 0;
            _armSelection(disputeId, d);
        } else {
            _resolveFallback(disputeId, d);
        }
    }

    /// @dev Applies the verdict to the purchase. Returns the case fee collected from the loser,
    ///      which the caller routes (treasury for mechanical grounds, jurors for FalseDescription).
    function _resolve(uint256 disputeId, Dispute storage d, bool upheld, uint256 confirmedMask)
        internal
        returns (uint256 caseFeePaid)
    {
        uint256 pid = d.purchaseId;
        Purchase storage p = _purchases[pid];
        d.status = DisputeStatus.Resolved;
        d.verdict = upheld ? Verdict.Uphold : Verdict.Reject;
        d.confirmedMask = confirmedMask;
        d.resolvedAt = uint64(block.timestamp);
        totalBonds -= d.bond;

        Stake storage st = _stakes[p.seller];
        st.reserved -= p.collateral;
        uint256 refund;
        uint256 penalty;
        uint256 toBuyer;
        if (upheld) {
            uint256 newMask = confirmedMask & ~p.remediedMask;
            uint256 cap = uint256(p.price) * p.refundCapBps / BPS;
            uint256 room = cap > p.refunded ? cap - p.refunded : 0;
            refund = _popcount(newMask) * (uint256(p.price) / p.taskCount);
            if (refund > room) refund = room;
            p.remediedMask |= newMask;

            caseFeePaid = p.caseFee < p.collateral ? p.caseFee : p.collateral;
            if (_popcount(confirmedMask) * BPS > uint256(p.taskCount) * p.penaltyThresholdBps) {
                penalty = uint256(p.price) * p.penaltyBps / BPS;
                uint256 left = p.collateral - caseFeePaid;
                if (penalty > left) penalty = left;
            }
            st.total -= uint128(caseFeePaid + penalty);
            totalCollateral -= caseFeePaid + penalty;
            reserve += penalty;
            p.penalties = uint128(penalty);
            toBuyer = refund + d.bond;
            _versionStats[p.versionId].disputesUpheld++;
            _sellerStats[p.seller].disputesUpheld++;
        } else {
            caseFeePaid = d.caseFee < d.bond ? d.caseFee : d.bond;
            reserve += d.bond - caseFeePaid; // never to the seller
        }
        d.refund = uint128(refund);

        uint256 proceeds = _closePurchase(pid, p, refund);
        emit DisputeResolved(disputeId, d.verdict, refund, proceeds, penalty);
        _credit(p.buyer, toBuyer);
    }

    /// @dev Rejected-without-fault: bond back in full, no refund, purchase settles normally.
    function _resolveFallback(uint256 disputeId, Dispute storage d) internal {
        uint256 pid = d.purchaseId;
        Purchase storage p = _purchases[pid];
        d.status = DisputeStatus.Resolved;
        d.verdict = Verdict.Reject;
        d.fallbackNoQuorum = true;
        d.resolvedAt = uint64(block.timestamp);
        uint256 bond = d.bond;
        totalBonds -= bond;
        _stakes[p.seller].reserved -= p.collateral;
        uint256 proceeds = _closePurchase(pid, p, 0);
        emit FallbackNoQuorum(disputeId, pid);
        emit DisputeResolved(disputeId, Verdict.Reject, 0, proceeds, 0);
        _credit(p.buyer, bond);
    }

    /// @dev Splits escrowed price into refund / fee / seller proceeds and marks the purchase Settled.
    ///      Caller must already have released the collateral reservation.
    function _closePurchase(uint256 pid, Purchase storage p, uint256 refund) internal returns (uint256 proceeds) {
        uint256 price = p.price;
        uint256 retained = price - refund;
        uint256 fee = retained * p.feeBps / BPS;
        proceeds = retained - fee;
        p.state = PurchaseState.Settled;
        p.refunded += uint128(refund);
        p.fee = uint128(fee);
        p.sellerProceeds = uint128(proceeds);
        p.settledAt = uint64(block.timestamp);
        totalEscrow -= price;
        treasury += fee;

        VersionStats storage vs = _versionStats[p.versionId];
        vs.settledCount++;
        vs.retainedVolume += retained;
        SellerStats storage ss = _sellerStats[p.seller];
        ss.retainedVolume += retained;
        if (retained > 0) ss.qualifyingTx++;

        emit PurchaseSettled(pid, proceeds, refund, fee);
        _credit(p.seller, proceeds);
    }

    function _credit(address to, uint256 amount) internal {
        if (amount == 0) return;
        claimable[to] += amount;
        totalClaimable += amount;
        emit Credited(to, amount);
    }

    function _payJurors(uint256 disputeId, Dispute storage d, uint256 base, Verdict verdict, uint256 pot, uint256 reveals)
        internal
    {
        Seat[6] storage seats = _seats[disputeId];
        uint256 per = d.participationFee;
        if (per * reveals > pot) per = pot / reveals;
        uint256 bonusPool = pot - per * reveals;
        uint256 minSlash = uint256(d.jurorStake) * d.minoritySlashBps / BPS;
        uint256 majority;
        for (uint256 k; k < SEATS; ++k) {
            Seat storage s = seats[base + k];
            if (!s.revealed) continue;
            JurorInfo storage j = _jurors[s.juror];
            j.locked -= d.jurorStake;
            if (s.vote == verdict) {
                majority++;
            } else {
                j.total -= uint128(minSlash);
                s.slashed = uint128(minSlash);
                totalJurorStake -= minSlash;
                bonusPool += minSlash;
                emit JurorSlashed(disputeId, d.round, s.juror, minSlash, false);
            }
            emit JurorStakeChanged(s.juror, j.total, j.locked);
        }
        uint256 share = bonusPool / majority;
        reserve += bonusPool - share * majority; // dust
        for (uint256 k; k < SEATS; ++k) {
            Seat storage s = seats[base + k];
            if (!s.revealed) continue;
            uint256 amt = per + (s.vote == verdict ? share : 0);
            s.reward = uint128(amt);
            if (amt > 0) {
                emit JurorPaid(disputeId, d.round, s.juror, amt);
                _credit(s.juror, amt);
            }
        }
    }

    function _quote(Purchase storage p, uint256 taskMask) internal view returns (uint256 requested, uint256 bond) {
        uint256 cap = uint256(p.price) * p.refundCapBps / BPS;
        requested = _popcount(taskMask) * (uint256(p.price) / p.taskCount);
        if (requested > cap) requested = cap;
        bond = requested < p.bondFloor ? p.bondFloor : (requested > p.bondCap ? p.bondCap : requested);
    }

    function _seatIndex(uint256 disputeId, uint8 round, address juror) internal view returns (uint256) {
        uint256 base = (uint256(round) - 1) * SEATS;
        Seat[6] storage seats = _seats[disputeId];
        for (uint256 k; k < SEATS; ++k) {
            if (seats[base + k].juror == juror) return base + k;
        }
        revert NotSeated();
    }

    function _allCommitted(uint256 disputeId, uint8 round) internal view returns (bool) {
        uint256 base = (uint256(round) - 1) * SEATS;
        Seat[6] storage seats = _seats[disputeId];
        for (uint256 k; k < SEATS; ++k) {
            if (seats[base + k].commitment == 0) return false;
        }
        return true;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        ECDSA.RecoverError err;
        (signer, err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError) revert BadSignature();
    }

    function _popcount(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            x &= x - 1;
            c++;
        }
    }

    // ================================================================== VIEWS
    /// @notice Every other read-only function (getVersion, getPurchase, getDispute, sellerStake, ...)
    ///         lives in EnvMarketViews and is served from this address via delegatecall.
    fallback() external {
        address impl = viewsModule;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function commitmentFor(uint256 disputeId, uint8 round, Verdict verdict, bytes32 salt, address juror)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(disputeId, round, uint8(verdict), salt, juror));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function previewReportDigest(uint256 versionId, bytes32 bundleHash, bytes32 reportHash)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(PREVIEW_REPORT_TYPEHASH, versionId, bundleHash, reportHash)));
    }

    function deliveryReceiptDigest(
        uint256 purchaseId,
        bytes32 buyerEncPubKey,
        bytes32 ciphertextHash,
        bytes32 wrappedKeyHash,
        bytes32 wrapperHash
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DELIVERY_RECEIPT_TYPEHASH, purchaseId, buyerEncPubKey, ciphertextHash, wrappedKeyHash, wrapperHash
                )
            )
        );
    }

    function mechanicalFindingDigest(uint256 disputeId, bool upheld, uint256 confirmedMask, bytes32 findingsHash)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(MECHANICAL_FINDING_TYPEHASH, disputeId, upheld, confirmedMask, findingsHash))
        );
    }
}
