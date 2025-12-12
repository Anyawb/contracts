// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationConfigManager
 * @dev 清算配置管理器接口 - 负责配置和模块管理
 * @dev Liquidation Config Manager Interface - Responsible for configuration and module management
 * @dev 提供模块地址缓存、配置更新、紧急暂停等功能
 * @dev Provides module address caching, configuration updates, emergency pause and other functions
 */
interface ILiquidationConfigManager {
    /* ============ Module Management Functions ============ */
    
    /**
     * 获取模块地址 - 从缓存中获取模块地址
     * Get module address - Get module address from cache
     * @param moduleKey 模块键值 Module key
     * @return moduleAddress 模块地址 Module address
     */
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress);

    /**
     * 更新模块 - 更新指定模块的缓存地址
     * Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     */
    function updateModule(bytes32 key, address addr) external;

    /**
     * 批量更新模块 - 一次性更新多个模块
     * Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external;

    /**
     * 移除模块 - 从缓存中移除指定模块
     * Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     */
    function removeModule(bytes32 key) external;

    /* ============ Query Functions ============ */
    
    /**
     * 获取缓存的协调器地址 - 获取缓存的清算协调器地址
     * Get cached orchestrator address - Get cached liquidation orchestrator address
     * @return orchestrator 协调器地址 Orchestrator address
     */
    function getCachedOrchestrator() external view returns (address orchestrator);

    /**
     * 获取缓存的计算器地址 - 获取缓存的清算计算器地址
     * Get cached calculator address - Get cached liquidation calculator address
     * @return calculator 计算器地址 Calculator address
     */
    function getCachedCalculator() external view returns (address calculator);

    /**
     * 获取缓存的奖励分配器地址 - 获取缓存的清算奖励分配器地址
     * Get cached reward distributor address - Get cached liquidation reward distributor address
     * @return rewardDistributor 奖励分配器地址 Reward distributor address
     */
    function getCachedRewardDistributor() external view returns (address rewardDistributor);

    /**
     * 获取缓存的记录管理器地址 - 获取缓存的清算记录管理器地址
     * Get cached record manager address - Get cached liquidation record manager address
     * @return recordManager 记录管理器地址 Record manager address
     */
    function getCachedRecordManager() external view returns (address recordManager);

    /**
     * 获取缓存的风险管理器地址 - 获取缓存的清算风险管理器地址
     * Get cached risk manager address - Get cached liquidation risk manager address
     * @return riskManager 风险管理器地址 Risk manager address
     */
    function getCachedRiskManager() external view returns (address riskManager);

    /**
     * 获取缓存的抵押物管理器地址 - 获取缓存的清算抵押物管理器地址
     * Get cached collateral manager address - Get cached liquidation collateral manager address
     * @return collateralManager 抵押物管理器地址 Collateral manager address
     */
    function getCachedCollateralManager() external view returns (address collateralManager);

    /**
     * 获取缓存的债务管理器地址 - 获取缓存的清算债务管理器地址
     * Get cached debt manager address - Get cached liquidation debt manager address
     * @return debtManager 债务管理器地址 Debt manager address
     */
    function getCachedDebtManager() external view returns (address debtManager);

    /**
     * 获取所有缓存的模块地址 - 获取所有缓存的清算模块地址
     * Get all cached module addresses - Get all cached liquidation module addresses
     * @return orchestrator 协调器地址 Orchestrator address
     * @return calculator 计算器地址 Calculator address
     * @return rewardDistributor 奖励分配器地址 Reward distributor address
     * @return recordManager 记录管理器地址 Record manager address
     * @return riskManager 风险管理器地址 Risk manager address
     * @return collateralManager 抵押物管理器地址 Collateral manager address
     * @return debtManager 债务管理器地址 Debt manager address
     */
    function getAllCachedModules() external view returns (
        address orchestrator,
        address calculator,
        address rewardDistributor,
        address recordManager,
        address riskManager,
        address collateralManager,
        address debtManager
    );

    /* ============ Emergency Functions ============ */
    
    /**
     * 紧急暂停 - 暂停所有操作
     * Emergency pause - Pause all operations
     */
    function emergencyPause() external;

    /**
     * 紧急恢复 - 恢复所有操作
     * Emergency unpause - Resume all operations
     */
    function emergencyUnpause() external;

    /**
     * 检查是否暂停 - 检查系统是否处于暂停状态
     * Check if paused - Check if system is in paused state
     * @return paused 是否暂停 Whether paused
     */
    function isPaused() external view returns (bool paused);
} 