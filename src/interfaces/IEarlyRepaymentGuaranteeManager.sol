// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IEarlyRepaymentGuaranteeManager
 * @notice Interface for early-repayment guarantee records and settlement hooks.
 * @dev Reverts if:
 *      - see implementation-specific function-level conditions in EarlyRepaymentGuaranteeManager
 *      - downstream integrations misuse block-based guarantee timing as wall-clock time
 *
 * Security:
 * - This interface is the SSOT for guarantee structs, events, and lifecycle hooks consumed by offchain systems.
 * - Timing fields in this subsystem are block-based despite legacy field names containing `Time` or `Days`.
 */
interface IEarlyRepaymentGuaranteeManager {
    /*━━━━━━━━━━━━━━━ Structs ━━━━━━━━━━━━━━━*/
    /// @notice Guarantee record for a borrower/asset pair.
    struct GuaranteeRecord {
        /// @notice Borrow principal amount (asset units).
        uint256 principal;
        /// @notice Promised interest amount locked as guarantee (asset units).
        uint256 promisedInterest;
        /// @dev Legacy field name. Semantics in this repo: startBlock (block.number), NOT unix time.
        uint256 startTime;
        /// @dev Legacy field name. Semantics in this repo: maturityBlock (block.number), NOT unix time.
        uint256 maturityTime;
        /// @dev Legacy field name. Semantics in this repo: penaltyBlocks (block.number axis), NOT days.
        uint256 earlyRepayPenaltyDays;
        /// @notice Whether the guarantee is active.
        bool isActive;
        /// @notice Lender address receiving penalties/forfeits.
        address lender;
        /// @notice Guarantee asset address.
        address asset;
    }

    /// @notice Early repayment settlement outcome (asset units).
    struct EarlyRepaymentResult {
        /// @notice Amount paid to lender from guarantee (asset units).
        uint256 penaltyToLender;
        /// @notice Amount refunded to borrower (asset units).
        uint256 refundToBorrower;
        /// @notice Platform fee (asset units).
        uint256 platformFee;
        /// @notice Interest actually paid to lender (asset units).
        uint256 actualInterestPaid;
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when a guarantee record is locked for a borrower and asset pair.
     * @dev Event only. Emitted by EarlyRepaymentGuaranteeManager; `blockNumber` is a block-based time marker.
     */
    event GuaranteeLocked(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 principal,
        uint256 promisedInterest,
        uint256 startTime,
        uint256 maturityTime,
        uint256 earlyRepayPenaltyDays,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when an early repayment is settled and the guarantee is distributed.
     * @dev Event only. Emitted by EarlyRepaymentGuaranteeManager; `blockNumber` is a block-based time marker.
     */
    event EarlyRepaymentProcessed(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 penaltyToLender,
        uint256 refundToBorrower,
        uint256 platformFee,
        uint256 actualInterestPaid,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when a guarantee is forfeited due to default.
     * @dev Event only. Emitted by EarlyRepaymentGuaranteeManager; `blockNumber` is a block-based time marker.
     */
    event GuaranteeForfeited(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 forfeitedAmount,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get a guarantee record by id.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * Note:
     * - If the id was never created, returns a zero-initialized record.
     *
     * @param guaranteeId Guarantee id.
     * @return record Guarantee record.
     */
    function getGuaranteeRecord(
        uint256 guaranteeId
    ) external view returns (GuaranteeRecord memory record);

    /**
     * @notice Get the active (or last) guarantee id for a (user, asset) pair.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * Note:
     * - Returns 0 if no guarantee has ever been set for the pair.
     *
     * @param user Borrower address.
     * @param asset Guarantee asset address.
     * @return guaranteeId Guarantee id (0 if none).
     */
    function getUserGuaranteeId(
        address user,
        address asset
    ) external view returns (uint256 guaranteeId);

    /**
     * @notice Check whether a user currently has an active guarantee for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param user Borrower address.
     * @param asset Guarantee asset address.
     * @return isActive True if an active guarantee exists, otherwise false.
     */
    function hasActiveGuarantee(
        address user,
        address asset
    ) external view returns (bool isActive);

    /**
     * @notice Preview early repayment settlement amounts for a guarantee id.
     * @dev Reverts if:
     *      - guarantee is not active (GuaranteeNotActive)
     *
     * Security:
     * - View-only
     *
     * @param guaranteeId Guarantee id.
     * @param actualRepayAmount Actual repay amount (asset units; reserved for future rules).
     * @return result Previewed settlement amounts.
     */
    function previewEarlyRepayment(
        uint256 guaranteeId,
        uint256 actualRepayAmount
    ) external view returns (EarlyRepaymentResult memory result);

    /*━━━━━━━━━━━━━━━ Core Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Lock a new early-repayment guarantee record for (borrower, asset).
     * @dev Reverts if:
     *      - caller is not VaultCore or VaultBusinessLogic resolved via Registry
     *        (EarlyRepaymentGuaranteeManager__OnlyVaultCore)
     *      - registry reference is zero or not a contract (ZeroAddress / NotAContract)
     *      - borrower/lender/asset is zero (ZeroAddress)
     *      - principal/promisedInterest/termDays is zero (AmountIsZero)
     *      - borrower == lender (BorrowerCannotBeLender)
     *      - termDays is out of range (InvalidGuaranteeTerm)
     *      - promisedInterest is too high vs principal (GuaranteeInterestTooHigh)
     *      - an active guarantee already exists for (borrower, asset) (GuaranteeAlreadyProcessed)
     *      - guarantee id counter overflows (GuaranteeIdOverflow)
     *      - guarantee feature is disabled for the asset (EarlyRepaymentGuaranteeManager__GuaranteeNotEnabled)
     *
     * Security:
     * - onlyVaultCoreOrBusinessLogic (Registry-resolved)
     * - nonReentrant
     *
     * @param borrower Borrower address.
     * @param lender Lender address.
     * @param asset Guarantee asset address.
     * @param principal Borrow principal amount (asset units).
     * @param promisedInterest Promised interest amount locked as guarantee (asset units).
     * @param termDays Loan term (days; converted to blocks in implementation).
     * @return guaranteeId New guarantee id.
     */
    function lockGuaranteeRecord(
        address borrower,
        address lender,
        address asset,
        uint256 principal,
        uint256 promisedInterest,
        uint256 termDays
    ) external returns (uint256 guaranteeId);

    /**
     * @notice Settle early repayment for (borrower, asset) by distributing the guarantee.
     * @dev Reverts if:
     *      - caller is not SettlementManager (or VaultCore for legacy flows) resolved via Registry
     *        (EarlyRepaymentGuaranteeManager__OnlySettlementManager)
     *      - registry reference is zero or not a contract (ZeroAddress / NotAContract)
     *      - borrower/asset is zero (ZeroAddress)
     *      - actualRepayAmount is zero (AmountIsZero)
     *      - no guarantee exists for (borrower, asset) (GuaranteeRecordNotFound)
     *      - guarantee is not active (GuaranteeNotActive)
     *      - guarantee feature is disabled for the asset (EarlyRepaymentGuaranteeManager__GuaranteeNotEnabled)
     *      - Registry missing KEY_GUARANTEE_FUND (Registry.getModuleOrRevert)
     *      - GuaranteeFundManager settlement reverts (ExternalModuleRevertedRaw)
     *
     * Security:
     * - onlySettlementManager (Registry-resolved; VaultCore allowed for legacy tests)
     * - nonReentrant
     * - CEI: record state is updated before external settlement call
     *
     * @param borrower Borrower address.
     * @param asset Guarantee asset address.
     * @param actualRepayAmount Actual repay amount (asset units; reserved for future rules).
     * @return result Computed settlement amounts.
     */
    function settleEarlyRepayment(
        address borrower,
        address asset,
        uint256 actualRepayAmount
    ) external returns (EarlyRepaymentResult memory result);

    /**
     * @notice Process default for (borrower, asset) by forfeiting the full guarantee to the lender.
     * @dev Reverts if:
     *      - caller is not SettlementManager (or VaultCore for legacy flows) resolved via Registry
     *        (EarlyRepaymentGuaranteeManager__OnlySettlementManager)
     *      - registry reference is zero or not a contract (ZeroAddress / NotAContract)
     *      - borrower/asset is zero (ZeroAddress)
     *      - no guarantee exists for (borrower, asset) (GuaranteeRecordNotFound)
     *      - guarantee is not active (GuaranteeNotActive)
     *      - guarantee feature is disabled for the asset (EarlyRepaymentGuaranteeManager__GuaranteeNotEnabled)
     *      - Registry missing KEY_GUARANTEE_FUND (Registry.getModuleOrRevert)
     *      - GuaranteeFundManager forfeiture reverts (ExternalModuleRevertedRaw)
     *
     * Security:
     * - onlySettlementManager (Registry-resolved; VaultCore allowed for legacy tests)
     * - nonReentrant
     * - CEI: record state is updated before external forfeiture call
     *
     * @param borrower Borrower address.
     * @param asset Guarantee asset address.
     * @return forfeitedAmount Amount forfeited (asset units).
     */
    function processDefault(
        address borrower,
        address asset
    ) external returns (uint256 forfeitedAmount);

    /*━━━━━━━━━━━━━━━ Feature Toggle ━━━━━━━━━━━━━━━*/
    /**
     * @notice Whether early-repayment guarantee is enabled for a given asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param asset Guarantee asset address.
     * @return enabled True if enabled, otherwise false.
     */
    function isGuaranteeEnabled(
        address asset
    ) external view returns (bool enabled);
}
