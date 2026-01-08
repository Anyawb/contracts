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