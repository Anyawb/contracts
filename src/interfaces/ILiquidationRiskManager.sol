// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILiquidationRiskRead} from "./ILiquidationRiskRead.sol";

/**
 * @title ILiquidationRiskManager
 * @notice Interface for liquidation risk assessment and threshold governance.
 * @dev Implemented by LiquidationRiskManager; this interface is the SSOT for read-only risk checks and
 *      governance updates to liquidation thresholds/min health factor/max LTV.
 */
interface ILiquidationRiskManager is ILiquidationRiskRead {
    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when liquidation threshold is updated.
     * @dev Emitted by LiquidationRiskManager; `blockNumber` represents
     *      blockNumber (block-based time axis).
     * @param oldThreshold Previous liquidation threshold (bps, 10_000 = 100%).
     * @param newThreshold New liquidation threshold (bps, 10_000 = 100%).
     * @param blockNumber Update blockNumber (block.number).
     */
    event LiquidationThresholdUpdated(
        uint256 oldThreshold,
        uint256 newThreshold,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Risk Assessment Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Check if a user is liquidatable based on cached health factor.
     * @dev Reverts if:
     *      - user is zero address (ZeroAddress)
     *      - Registry missing KEY_HEALTH_VIEW (LiquidationRiskManager__MissingModule)
     *
     * Security:
     * - View-only
     * - Best-effort: returns false if HealthView cache is invalid
     *
     * @param user User address.
     * @return liquidatable True if liquidatable, otherwise false.
     */
    function isLiquidatable(
        address user
    ) external view returns (bool liquidatable);

    /**
     * @notice Check if a position is liquidatable using provided collateral/debt values.
     * @dev Reverts if:
     *      - user or asset is zero address (ZeroAddress)
     *
     * Security:
     * - View-only
     * - Uses HealthFactorLib.isUnderCollateralized for hot-path checks
     *
     * @param user User address.
     * @param collateral Collateral value (same precision as debt).
     * @param debt Debt value (same precision as collateral).
     * @param asset Asset address.
     * @return liquidatable True if liquidatable, otherwise false.
     */
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view returns (bool liquidatable);

    /**
     * @notice Get a user's liquidation risk score.
     * @dev Reverts if:
     *      - user is zero address (ZeroAddress)
     *
     * Security:
     * - View-only
     * - Best-effort: missing valuation modules may yield (0,0) inputs and thus score 0
     *
     * @param user User address.
     * @return riskScore Risk score in [0,100] (0 = lowest risk, 100 = highest).
     */
    function getLiquidationRiskScore(
        address user
    ) external view returns (uint256 riskScore);

    /**
     * @notice Calculate liquidation risk score for given collateral/debt values.
     * @dev Reverts if:
     *      - (none; pure function)
     *
     * Security:
     * - Pure computation (no state access)
     *
     * @param collateral Collateral value (same precision as debt).
     * @param debt Debt value (same precision as collateral).
     * @return riskScore Risk score in [0,100] (0 = lowest risk, 100 = highest).
     */
    function calculateLiquidationRiskScore(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256 riskScore);

    /**
     * @notice Get a comprehensive liquidation risk assessment for a user.
     * @dev Reverts if:
     *      - user is zero address (ZeroAddress)
     *      - Registry missing KEY_HEALTH_VIEW (LiquidationRiskManager__MissingModule)
     *
     * Security:
     * - View-only
     * - Best-effort: healthFactor returns 0 if cache is invalid; riskScore may be 0 if valuation modules are missing
     *
     * @param user User address.
     * @return liquidatable True if liquidatable, otherwise false.
     * @return riskScore Risk score in [0,100].
     * @return healthFactor Health factor in bps (10_000 = 100%, 0 if invalid).
     * @return riskLevel Risk level (0-4).
     * @return safetyMargin Safety margin in bps.
     */
    function getUserRiskAssessment(
        address user
    )
        external
        view
        returns (
            bool liquidatable,
            uint256 riskScore,
            uint256 healthFactor,
            uint256 riskLevel,
            uint256 safetyMargin
        );

    /*━━━━━━━━━━━━━━━ Threshold Management Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get liquidation threshold.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - SSOT migration: prefers LiquidationConfigManager if registered; falls back to local mirror
     *
     * @return threshold Liquidation threshold (bps, 10_000 = 100%).
     */
    function getLiquidationThreshold()
        external
        view
        returns (uint256 threshold);

    /**
     * @notice Update liquidation threshold.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (via AccessControlManager.requireRole)
     *      - newThreshold is invalid (LiquidationRiskManager__InvalidThreshold)
     *      - LiquidationConfigManager update reverts (if registered)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     * - Best-effort ConfigManager sync; skipped if module missing
     *
     * @param newThreshold New liquidation threshold (bps, 10_000 = 100%).
     */
    function updateLiquidationThreshold(uint256 newThreshold) external;

    /**
     * @notice Get minimum health factor.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - SSOT migration: prefers LiquidationConfigManager if registered; falls back to local mirror
     *
     * @return minHealthFactor Minimum health factor (bps, 10_000 = 100%).
     */
    function getMinHealthFactor()
        external
        view
        returns (uint256 minHealthFactor);

    /**
     * @notice Update minimum health factor.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (via AccessControlManager.requireRole)
     *      - newMinHealthFactor is invalid (LiquidationRiskManager__InvalidThreshold)
     *      - LiquidationConfigManager update reverts (if registered)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     * - Best-effort ConfigManager sync; skipped if module missing
     *
     * @param newMinHealthFactor New minimum health factor (bps, 10_000 = 100%).
     */
    function updateMinHealthFactor(uint256 newMinHealthFactor) external;

    /**
     * @notice Get maximum LTV.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - SSOT migration: prefers LiquidationConfigManager if registered; falls back to local mirror
     *
     * @return maxLtvBps Maximum LTV (bps, 10_000 = 100%).
     */
    function getMaxLtvBps() external view returns (uint256 maxLtvBps);

    /**
     * @notice Update maximum LTV.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (via AccessControlManager.requireRole)
     *      - newMaxLtvBps is invalid (LiquidationRiskManager__InvalidThreshold)
     *      - LiquidationConfigManager update reverts (if registered)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     * - Best-effort ConfigManager sync; skipped if module missing
     *
     * @param newMaxLtvBps New maximum LTV (bps, 10_000 = 100%).
     */
    function updateMaxLtvBps(uint256 newMaxLtvBps) external;

    /*━━━━━━━━━━━━━━━ Batch Query Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Batch check liquidatability for multiple users.
     * @dev Reverts if:
     *      - users.length exceeds maxBatchSize (LiquidationRiskManager__InvalidBatchSize)
     *      - Registry missing KEY_HEALTH_VIEW when encountering a non-zero user
     *
     * Security:
     * - View-only
     * - Best-effort: zero-address users return false
     *
     * @param users Array of user addresses.
     * @return liquidatableFlags Array of liquidatable flags.
     */
    function batchIsLiquidatable(
        address[] calldata users
    ) external view returns (bool[] memory liquidatableFlags);

    /**
     * @notice Batch get liquidation risk scores for multiple users.
     * @dev Reverts if:
     *      - users.length exceeds maxBatchSize (LiquidationRiskManager__InvalidBatchSize)
     *
     * Security:
     * - View-only
     * - Best-effort: zero-address users return score 0
     *
     * @param users Array of user addresses.
     * @return riskScores Array of risk scores (0-100).
     */
    function batchGetLiquidationRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores);

    /*━━━━━━━━━━━━━━━ Preview Functions moved to View contract ━━━━━━━━━━━━━━━*/
}
