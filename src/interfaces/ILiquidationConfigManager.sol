// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationConfigManager
 * @notice Liquidation configuration manager interface - responsible for configuration and module management
 * @dev Provides module address caching, configuration updates, emergency pause and other functions
 */
interface ILiquidationConfigManager {
    /* ============ Module Management Functions ============ */
    
    /**
     * @notice Get module address from cache
     * @param moduleKey Module key
     * @return moduleAddress Module address
     */
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress);

    /* ============ Liquidation Parameter Governance ============ */

    /**
     * @notice Update liquidation bonus rate.
     * @param newRate New bonus rate (bps=1e4)
     */
    function updateLiquidationBonusRate(uint256 newRate) external;

    /**
     * @notice Get liquidation bonus rate.
     * @return bonusRate Bonus rate (bps=1e4)
     */
    function getLiquidationBonusRate() external view returns (uint256 bonusRate);

    /**
     * @notice Update liquidation threshold.
     * @param newThreshold New threshold (bps=1e4)
     */
    function updateLiquidationThreshold(uint256 newThreshold) external;

    /**
     * @notice Get liquidation threshold.
     * @return threshold Threshold (bps=1e4)
     */
    function getLiquidationThreshold() external view returns (uint256 threshold);

    /**
     * @notice Update minimum health factor.
     * @param newMinHealthFactor New minimum health factor (bps=1e4)
     */
    function updateMinHealthFactor(uint256 newMinHealthFactor) external;

    /**
     * @notice Get minimum health factor.
     * @return minHealthFactor Minimum health factor (bps=1e4)
     */
    function getMinHealthFactor() external view returns (uint256 minHealthFactor);

    /* ============ Query Functions ============ */
    
    /**
     * @notice Get cached orchestrator address
     * @return orchestrator Orchestrator address
     */
    function getCachedOrchestrator() external view returns (address orchestrator);

    /**
     * @notice Get cached calculator address
     * @return calculator Calculator address
     */
    function getCachedCalculator() external view returns (address calculator);

    /**
     * @notice Get cached risk manager address
     * @return riskManager Risk manager address
     */
    function getCachedRiskManager() external view returns (address riskManager);

    /**
     * @notice Get all cached module addresses
     * @return orchestrator Orchestrator address
     * @return calculator Calculator address
     * @return riskManager Risk manager address
     * @return collateralManager Collateral manager address
     * @return debtManager Debt manager address
     */
    function getAllCachedModules() external view returns (
        address orchestrator,
        address calculator,
        address riskManager,
        address collateralManager,
        address debtManager
    );

    /* ============ Emergency Functions ============ */
    
    /**
     * @notice Emergency pause all operations
     */
    function emergencyPause() external;

    /**
     * @notice Emergency unpause all operations
     */
    function emergencyUnpause() external;

    /**
     * @notice Check if system is paused
     * @return paused Whether the system is paused
     */
    function isPaused() external view returns (bool paused);
} 