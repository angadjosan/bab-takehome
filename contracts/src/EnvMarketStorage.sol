// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EnvMarketStorage — types, constants, storage layout and errors shared by EnvMarket and
///        EnvMarketViews. MUST be the first base of both so their storage slots line up
///        (EnvMarket delegatecalls EnvMarketViews for read-only functions).
abstract contract EnvMarketStorage {
    // ------------------------------------------------------------------ enums
    enum PurchaseState { None, Funded, Delivered, Disputed, Refunded, Settled }
    enum Ground { None, BrokenOrHashMismatch, FalseDescription, PreviewNotReproducible }
    enum DisputeStatus { None, AwaitingSelection, Voting, Resolved }
    enum Verdict { None, Uphold, Reject } // Uphold = buyer wins

    // ---------------------------------------------------------------- structs
    struct Params {
        uint32 challengeWindow; // default + minimum challenge window for new versions
        uint32 deliveryWindow; // default + maximum delivery window for new versions
        uint16 refundCapBps;
        uint16 penaltyThresholdBps;
        uint16 penaltyBps;
        uint16 feeBps;
        uint128 bondFloor;
        uint128 bondCap;
        uint128 caseFee;
        uint128 participationFee;
        uint128 jurorStake;
        uint16 minoritySlashBps;
        uint16 nonRevealSlashBps;
        uint32 commitWindow;
        uint32 revealWindow;
        uint32 verifierTimeout; // mechanical disputes: after this, anyone may apply the no-fault fallback
    }

    struct VersionInput {
        bytes32 bundleHash;
        bytes32 ciphertextHash;
        bytes32 imageDigest;
        bytes32 descriptionHash;
        bytes32 manifestHash;
        bytes32 licenseHash;
        bytes32 taskRoot;
        bytes32 auditRoot;
        uint16 taskCount;
        uint16 auditTaskCount;
        uint128 price;
        uint128 collateral;
        uint32 deliveryWindow; // 0 => params.deliveryWindow
        uint32 challengeWindow; // 0 => params.challengeWindow
        string uri;
    }

    struct VersionTerms {
        address seller;
        uint64 listingId;
        uint32 versionNo;
        bytes32 bundleHash;
        bytes32 ciphertextHash;
        bytes32 imageDigest;
        bytes32 descriptionHash;
        bytes32 manifestHash;
        bytes32 licenseHash;
        bytes32 taskRoot;
        bytes32 auditRoot;
        uint16 taskCount;
        uint16 auditTaskCount;
        uint128 price;
        uint128 collateral;
        uint32 deliveryWindow;
        uint32 challengeWindow;
        bytes32 reportHash;
        string uri;
        bool active;
    }

    struct Purchase {
        uint256 versionId;
        address buyer;
        address seller;
        PurchaseState state;
        uint128 price;
        uint128 collateral;
        bytes32 buyerEncPubKey;
        uint64 fundedAt;
        uint64 deliveryDeadline;
        uint64 deliveredAt;
        uint64 challengeDeadline;
        uint32 challengeWindow;
        uint16 taskCount;
        // snapshotted economic params
        uint16 feeBps;
        uint16 refundCapBps;
        uint16 penaltyThresholdBps;
        uint16 penaltyBps;
        uint128 bondFloor;
        uint128 bondCap;
        uint128 caseFee;
        // delivery record
        bytes32 ciphertextHash;
        bytes32 wrappedKeyHash;
        bytes32 wrapperHash;
        address relay;
        // dispute / settlement record
        uint256 disputeId;
        uint256 remediedMask;
        uint128 refunded;
        uint128 sellerProceeds;
        uint128 fee;
        uint128 penalties;
        uint64 settledAt;
        bool rated;
        uint8 stars;
    }

    struct Dispute {
        uint256 purchaseId;
        Ground ground;
        DisputeStatus status;
        Verdict verdict;
        uint8 round;
        bool fallbackNoQuorum; // resolved by the no-quorum / verifier-timeout fallback
        uint256 taskMask;
        uint256 confirmedMask;
        bytes32 evidenceHash;
        bytes32 findingsHash;
        uint128 requested;
        uint128 bond;
        uint128 refund;
        // snapshotted adjudication params
        uint128 caseFee;
        uint128 participationFee;
        uint128 jurorStake;
        uint16 minoritySlashBps;
        uint16 nonRevealSlashBps;
        uint32 commitWindow;
        uint32 revealWindow;
        uint64 openedAt;
        uint64 selectionBlock;
        uint64 selectionDeadline; // jurors: after this, an unfillable panel counts as a failed round
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 verifierDeadline; // mechanical: after this, timeoutMechanical() may apply the fallback
        uint64 resolvedAt;
    }

    struct Seat {
        address juror;
        Verdict vote;
        bool revealed;
        bytes32 commitment;
        uint128 reward;
        uint128 slashed;
    }

    struct JurorInfo {
        bool approved;
        bool listed;
        uint128 total;
        uint128 locked;
    }

    struct Stake {
        uint128 total;
        uint128 reserved;
    }

    struct VersionStats {
        uint64 ratingSum;
        uint64 ratingCount;
        uint64 settledCount;
        uint64 disputesOpened;
        uint64 disputesUpheld;
        uint256 retainedVolume;
    }

    struct SellerStats {
        uint64 qualifyingTx;
        uint64 disputesOpened;
        uint64 disputesUpheld;
        uint64 fullRefunds;
        uint256 retainedVolume;
        uint256 weightedRatingSum;
        uint256 ratedRetained;
    }

    // -------------------------------------------------------------- constants
    uint256 internal constant BPS = 10_000;
    uint256 public constant SEATS = 3;
    uint256 public constant QUALIFYING_TX_THRESHOLD = 100;
    uint256 public constant MAX_JURORS = 200;

    // ------------------------------------------------------------------ state
    Params internal _params;

    uint256 public nextListingId = 1;
    uint256 public nextVersionId = 1;
    uint256 public nextPurchaseId = 1;
    uint256 public nextDisputeId = 1;

    mapping(address => bool) public isRunner;
    mapping(address => bool) public isRelay;
    mapping(address => bool) public isVerifier;

    mapping(uint256 => address) public listingSeller;
    mapping(uint256 => uint256[]) internal _listingVersions;
    mapping(address => uint256[]) internal _sellerVersions;
    mapping(address => uint256[]) internal _buyerPurchases;
    mapping(address => uint256[]) internal _sellerPurchases;

    mapping(uint256 => VersionTerms) internal _versions;
    mapping(uint256 => Purchase) internal _purchases;
    mapping(uint256 => Dispute) internal _disputes;
    mapping(uint256 => Seat[6]) internal _seats; // round r uses indices (r-1)*3 .. (r-1)*3+2

    mapping(address => Stake) internal _stakes;
    mapping(address => JurorInfo) internal _jurors;
    address[] internal _jurorList;

    mapping(uint256 => VersionStats) internal _versionStats;
    mapping(address => SellerStats) internal _sellerStats;

    // Accounting buckets (sum == token.balanceOf(this), see invariant tests)
    uint256 public totalEscrow; // prices of Funded/Delivered/Disputed purchases
    uint256 public totalCollateral; // Σ seller collateral totals
    uint256 public totalBonds; // Σ open dispute bonds
    uint256 public totalJurorStake; // Σ juror stake totals
    uint256 public treasury; // marketplace fees + mechanical case fees
    uint256 public reserve; // neutral reserve: penalties, forfeited bonds, non-reveal slashes, dust
    uint256 public totalClaimable; // Σ claimable (pull-payment balances)

    /// @notice Pull-payment balances: every payout (refunds, bonds, seller proceeds, juror rewards)
    ///         is credited here and withdrawn by its owner with `withdraw()`, so one blocked address
    ///         (e.g. a USDC-blacklisted recipient) can never brick settlement for anybody else.
    mapping(address => uint256) public claimable;

    // ----------------------------------------------------------------- errors
    error Unauthorized();
    error UnknownListing();
    error UnknownVersion();
    error UnknownPurchase();
    error UnknownDispute();
    error InvalidParams();
    error InvalidTerms();
    error VersionInactive();
    error ReportMissing();
    error ReportAlreadyAttached();
    error BadSignature();
    error SelfPurchase();
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error CollateralBelowRequirement(uint256 collateral, uint256 required);
    error InsufficientCollateral(uint256 available, uint256 needed);
    error InsufficientStake(uint256 free, uint256 needed);
    error InsufficientFunds();
    error WrongState();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error CiphertextMismatch();
    error BadGround();
    error BadMask();
    error BadVerdict();
    error BadStars();
    error TooEarly();
    error NotEnoughJurors();
    error NotSeated();
    error AlreadyCommitted();
    error NotCommitted();
    error AlreadyRevealed();
    error CommitmentMismatch();
    error AlreadyRated();
    error NotEligible();
    error JurorNotApproved();
    error TooManyJurors();
    error ZeroValue();

}
