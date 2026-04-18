// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IShortfallLedger {
    enum ShortfallStatus {
        NONE,
        ACTIVE,
        RECOVERY_PENDING,
        GUARANTEE_PENDING,
        GOVERNANCE_PENDING,
        RESOLVED,
        WRITTEN_OFF
    }

    enum PricingMode {
        STRICT_ORACLE,
        FALLBACK_ORACLE,
        REFERENCE_ONLY
    }

    enum RecoverySource {
        NONE,
        GUARANTEE_FUND,
        INSURANCE_FUND,
        OFFCHAIN_RECOVERY,
        MANUAL_SETTLEMENT,
        GOVERNANCE_WRITE_OFF
    }

    struct ShortfallLedger {
        uint256 orderId;
        address borrower;
        address debtAsset;
        address collateralAsset;
        ShortfallStatus status;
        PricingMode pricingMode;
        RecoverySource recoverySource;
        uint256 liquidationBlock;
        uint256 valuationBlock;
        uint256 coveredDebt;
        uint256 remainingDebt;
        uint256 shortfallAmount;
        uint256 recoveredAmount;
        uint256 lastRecoveryBlock;
        bytes32 evidenceHash;
    }

    struct RecordShortfallParams {
        uint256 orderId;
        address borrower;
        address debtAsset;
        address collateralAsset;
        PricingMode pricingMode;
        uint256 liquidationBlock;
        uint256 valuationBlock;
        uint256 coveredDebt;
        uint256 remainingDebt;
        uint256 shortfallAmount;
        bytes32 evidenceHash;
    }

    event LiquidationShortfallOpened(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed debtAsset,
        ShortfallStatus status,
        PricingMode pricingMode,
        uint256 coveredDebt,
        uint256 remainingDebt,
        uint256 shortfallAmount,
        uint256 valuationBlock,
        uint256 liquidationBlock,
        bytes32 evidenceHash
    );

    event LiquidationShortfallRecoveryApplied(
        uint256 indexed orderId,
        RecoverySource indexed recoverySource,
        uint256 recoveryAmount,
        uint256 remainingDebt,
        uint256 shortfallAmount,
        uint256 lastRecoveryBlock,
        bytes32 evidenceHash
    );

    event LiquidationShortfallStatusChanged(
        uint256 indexed orderId,
        ShortfallStatus previousStatus,
        ShortfallStatus newStatus,
        uint256 remainingDebt,
        uint256 shortfallAmount,
        bytes32 evidenceHash
    );

    function getShortfallLedger(
        uint256 orderId
    ) external view returns (ShortfallLedger memory ledger);

    function hasActiveShortfall(
        uint256 orderId
    ) external view returns (bool hasShortfall);

    function recordLiquidationShortfall(
        RecordShortfallParams calldata params
    ) external;

    /**
     * @notice Applies a debt-reduction recovery entry to an active shortfall ledger.
     * @dev For INSURANCE_FUND and OFFCHAIN_RECOVERY sources, evidenceHash must be non-zero.
     */
    function applyShortfallRecovery(
        uint256 orderId,
        RecoverySource recoverySource,
        uint256 recoveryAmount,
        bytes32 evidenceHash
    ) external;

    function setShortfallStatus(
        uint256 orderId,
        ShortfallStatus newStatus,
        bytes32 evidenceHash
    ) external;
}
