// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationProfitStatsManager
 * @dev 清算人收益统计管理器接口 - 负责清算人收益统计的存储、查询和管理
 * @dev Liquidation Profit Stats Manager Interface - Responsible for liquidator profit statistics storage, query and management
 * @dev 从 ILiquidationDebtManager 拆分出的清算人收益统计管理接口
 * @dev Liquidator profit statistics management interface split from ILiquidationDebtManager
 */
interface ILiquidationProfitStatsManager {
    /* ============ Events ============ */
    
    /**
     * 清算人收益统计更新事件 - 当清算人收益统计更新时触发
     * Liquidator profit stats updated event - Triggered when liquidator profit stats is updated
     * @param liquidator 清算人地址 Liquidator address
     * @param oldProfit 旧收益 Old profit
     * @param newProfit 新收益 New profit
     * @param timestamp 时间戳 Timestamp
     */
    event LiquidatorProfitStatsUpdated(
        address indexed liquidator,
        uint256 oldProfit,
        uint256 newProfit,
        uint256 timestamp
    );

    /**
     * 全局清算统计更新事件 - 当全局清算统计更新时触发
     * Global liquidation stats updated event - Triggered when global liquidation stats is updated
     * @param totalLiquidations 总清算次数 Total liquidations
     * @param totalProfit 总收益 Total profit
     * @param timestamp 时间戳 Timestamp
     */
    event GlobalLiquidationStatsUpdated(
        uint256 totalLiquidations,
        uint256 totalProfit,
        uint256 timestamp
    );

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

    /* ============ Core Stats Management Functions ============ */
    
    /**
     * 更新清算人收益统计 - 更新指定清算人的收益统计
     * Update liquidator profit stats - Update profit stats for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @param profit 收益 Profit amount
     */
    function updateLiquidatorProfitStats(address liquidator, uint256 profit) external;

    /**
     * 批量更新清算人收益统计 - 批量更新多个清算人的收益统计
     * Batch update liquidator profit stats - Batch update profit stats for multiple liquidators
     * @param liquidators 清算人地址数组 Array of liquidator addresses
     * @param profits 收益数组 Array of profit amounts
     */
    function batchUpdateLiquidatorProfitStats(
        address[] calldata liquidators,
        uint256[] calldata profits
    ) external;

    /**
     * 重置清算人收益统计 - 重置指定清算人的收益统计
     * Reset liquidator profit stats - Reset profit stats for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     */
    function resetLiquidatorProfitStats(address liquidator) external;

    /* ============ Query Functions ============ */
    
    /**
     * 获取清算人收益统计 - 获取指定清算人的收益统计
     * Get liquidator profit stats - Get profit stats for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @return totalProfit 总收益 Total profit
     * @return liquidationCount 清算次数 Liquidation count
     * @return lastLiquidationTime 最后清算时间 Last liquidation time
     */
    function getLiquidatorProfitStats(
        address liquidator
    ) external view returns (
        uint256 totalProfit,
        uint256 liquidationCount,
        uint256 lastLiquidationTime
    );

    /**
     * 获取全局清算统计 - 获取全局清算统计信息
     * Get global liquidation stats - Get global liquidation statistics
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return totalProfit 总收益 Total profit
     * @return activeLiquidators 活跃清算人数 Active liquidators count
     * @return lastUpdateTime 最后更新时间 Last update time
     */
    function getGlobalLiquidationStats() external view returns (
        uint256 totalLiquidations,
        uint256 totalProfit,
        uint256 activeLiquidators,
        uint256 lastUpdateTime
    );

    /**
     * 获取清算人排行榜 - 获取收益最高的清算人排行榜
     * Get liquidator leaderboard - Get leaderboard of liquidators with highest profits
     * @param limit 限制数量 Limit count
     * @return liquidators 清算人地址数组 Array of liquidator addresses
     * @return profits 收益数组 Array of profit amounts
     */
    function getLiquidatorLeaderboard(
        uint256 limit
    ) external view returns (
        address[] memory liquidators,
        uint256[] memory profits
    );

    /**
     * 检查清算人是否有收益统计 - 检查指定清算人是否有收益统计
     * Check if liquidator has profit stats - Check if specified liquidator has profit stats
     * @param liquidator 清算人地址 Liquidator address
     * @return hasStats 是否有统计 Whether has stats
     */
    function hasLiquidatorProfitStats(address liquidator) external view returns (bool hasStats);

    /**
     * 获取活跃清算人数量 - 获取活跃清算人的数量
     * Get active liquidators count - Get count of active liquidators
     * @return activeCount 活跃数量 Active count
     */
    function getActiveLiquidatorsCount() external view returns (uint256 activeCount);

    /* ============ Batch Query Functions ============ */
    
    /**
     * 批量获取清算人收益统计 - 批量获取多个清算人的收益统计
     * Batch get liquidator profit stats - Batch get profit stats for multiple liquidators
     * @param liquidators 清算人地址数组 Array of liquidator addresses
     * @return totalProfits 总收益数组 Array of total profits
     * @return liquidationCounts 清算次数数组 Array of liquidation counts
     * @return lastLiquidationTimes 最后清算时间数组 Array of last liquidation times
     */
    function batchGetLiquidatorProfitStats(
        address[] calldata liquidators
    ) external view returns (
        uint256[] memory totalProfits,
        uint256[] memory liquidationCounts,
        uint256[] memory lastLiquidationTimes
    );
} 