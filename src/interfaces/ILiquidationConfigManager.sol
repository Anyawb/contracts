// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationConfigManager
 * @notice Interface for liquidation configuration, cache management, and emergency pause controls.
 * @dev Implemented by LiquidationConfigManager; this interface is the SSOT for governance-controlled
 *      liquidation parameters and cache accessors.
 */
interface ILiquidationConfigManager {
    /*━━━━━━━━━━━━━━━ Module Management Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get a module address using the cache (best-effort).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - Best-effort: may return address(0) if cache and Registry are missing entries.
     *
     * @param moduleKey Module key (see ModuleKeys).
     * @return moduleAddress Cached module address (best-effort).
     */
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress);

    /*━━━━━━━━━━━━━━━ Liquidation Parameter Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Update liquidation bonus rate.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (via AccessControlManager.requireRole)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newRate New bonus rate (bps, 10_000 = 100%).
     */
    function updateLiquidationBonusRate(uint256 newRate) external;

    /**
     * @notice Get liquidation bonus rate.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return bonusRate Bonus rate (bps, 10_000 = 100%).
     */
    function getLiquidationBonusRate() external view returns (uint256 bonusRate);

    /**
     * @notice Update liquidation threshold.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (via AccessControlManager.requireRole)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newThreshold New threshold (bps, 10_000 = 100%).
     */
    function updateLiquidationThreshold(uint256 newThreshold) external;

    /**
     * @notice Get liquidation threshold.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return threshold Threshold (bps, 10_000 = 100%).
     */
    function getLiquidationThreshold() external view returns (uint256 threshold);

    /**
     * @notice Update minimum health factor.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (via AccessControlManager.requireRole)
     *      - newMinHealthFactor is zero or below liquidationThreshold (LiquidationConfigManager__InvalidMinHealthFactor)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newMinHealthFactor New minimum health factor (bps, 10_000 = 100%).
     */
    function updateMinHealthFactor(uint256 newMinHealthFactor) external;

    /**
     * @notice Get minimum health factor.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return minHealthFactor Minimum health factor (bps, 10_000 = 100%).
     */
    function getMinHealthFactor() external view returns (uint256 minHealthFactor);

    /**
     * @notice Update maximum LTV.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (via AccessControlManager.requireRole)
     *      - newMaxLtvBps is invalid (LiquidationConfigManager__InvalidMaxLtvBps)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newMaxLtvBps New maximum LTV (bps, 10_000 = 100%).
     */
    function updateMaxLtvBps(uint256 newMaxLtvBps) external;

    /**
     * @notice Get maximum LTV.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return maxLtvBps Maximum LTV (bps, 10_000 = 100%).
     */
    function getMaxLtvBps() external view returns (uint256 maxLtvBps);

    /*━━━━━━━━━━━━━━━ Query Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get cached liquidation orchestrator address (best-effort).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - Best-effort: may return address(0) if cache and Registry are missing entries.
     *
     * @return orchestrator Orchestrator address.
     */
    function getCachedOrchestrator() external view returns (address orchestrator);

    /**
     * @notice Get cached liquidation calculator address (best-effort).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - Best-effort: may return address(0) if cache and Registry are missing entries.
     *
     * @return calculator Calculator address.
     */
    function getCachedCalculator() external view returns (address calculator);

    /**
     * @notice Get cached liquidation risk manager address (best-effort).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - Best-effort: may return address(0) if cache and Registry are missing entries.
     *
     * @return riskManager Risk manager address.
     */
    function getCachedRiskManager() external view returns (address riskManager);

    /**
     * @notice Get all cached module addresses (best-effort).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - Best-effort: any returned address may be zero if cache and Registry are missing entries.
     *
     * @return orchestrator Orchestrator address.
     * @return calculator Calculator address.
     * @return riskManager Risk manager address.
     * @return collateralManager Collateral manager address.
     * @return debtManager Debt manager address.
     */
    function getAllCachedModules() external view returns (
        address orchestrator,
        address calculator,
        address riskManager,
        address collateralManager,
        address debtManager
    );

    /*━━━━━━━━━━━━━━━ Emergency Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Emergency pause liquidation operations.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_LIQUIDATE (via AccessControlManager.requireRole)
     *
     * Security:
     * - Role-gated (ACTION_LIQUIDATE)
     * - Pauses liquidation operations until unpaused
     */
    function emergencyPause() external;

    /**
     * @notice Emergency unpause liquidation operations.
     * @dev Reverts if:
     *      - Registry missing KEY_ACCESS_CONTROL (Registry.getModuleOrRevert)
     *      - caller lacks ACTION_LIQUIDATE (via AccessControlManager.requireRole)
     *
     * Security:
     * - Role-gated (ACTION_LIQUIDATE)
     */
    function emergencyUnpause() external;

    /**
     * @notice Check if the liquidation system is paused.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return paused True if paused, otherwise false.
     */
    function isPaused() external view returns (bool paused);
} 