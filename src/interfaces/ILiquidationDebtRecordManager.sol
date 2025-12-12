// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationDebtRecordManager
 * @dev 清算债务记录管理器接口 - 负责清算债务记录的存储、查询和管理
 * @dev Liquidation Debt Record Manager Interface - Responsible for liquidation debt record storage, query and management
 * @dev 从 ILiquidationDebtManager 拆分出的清算债务记录管理接口
 * @dev Liquidation debt record management interface split from ILiquidationDebtManager
 */
interface ILiquidationDebtRecordManager {
    /* ============ Events ============ */
    
    /**
     * 清算债务记录更新事件 - 当清算债务记录更新时触发
     * Liquidation debt record updated event - Triggered when liquidation debt record is updated
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param oldAmount 旧数量 Old amount
     * @param newAmount 新数量 New amount
     * @param timestamp 时间戳 Timestamp
     */
    event LiquidationDebtRecordUpdated(
        address indexed user,
        address indexed asset,
        uint256 oldAmount,
        uint256 newAmount,
        uint256 timestamp
    );

    /**
     * 清算债务记录清除事件 - 当清算债务记录被清除时触发
     * Liquidation debt record cleared event - Triggered when liquidation debt record is cleared
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param clearedAmount 清除数量 Cleared amount
     * @param timestamp 时间戳 Timestamp
     */
    event LiquidationDebtRecordCleared(
        address indexed user,
        address indexed asset,
        uint256 clearedAmount,
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

    /* ============ Core Record Management Functions ============ */
    
    /**
     * 更新清算债务记录 - 更新指定用户的清算债务记录
     * Update liquidation debt record - Update liquidation debt record for specified user
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param amount 清算数量 Liquidation amount
     * @param liquidator 清算人地址 Liquidator address
     */
    function updateLiquidationDebtRecord(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external;

    /**
     * 清除用户清算债务记录 - 清除指定用户的清算债务记录
     * Clear liquidation debt record - Clear liquidation debt record for specified user
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     */
    function clearLiquidationDebtRecord(address user, address asset) external;

    /**
     * 批量清除用户清算债务记录 - 批量清除指定用户的清算债务记录
     * Batch clear liquidation debt records - Batch clear liquidation debt records for specified user
     * @param user 用户地址 User address
     * @param assets 资产地址数组 Array of asset addresses
     */
    function batchClearLiquidationDebtRecords(address user, address[] calldata assets) external;

    /* ============ Query Functions ============ */
    
    /**
     * 获取用户清算债务记录 - 获取指定用户的清算债务记录
     * Get liquidation debt record - Get liquidation debt record for specified user
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @return reducedAmount 已清算债务数量 Reduced debt amount
     * @return lastReducedTime 最后清算时间 Last reduction time
     */
    function getLiquidationDebtRecord(
        address user,
        address asset
    ) external view returns (uint256 reducedAmount, uint256 lastReducedTime);

    /**
     * 获取用户所有清算债务记录 - 获取指定用户的所有清算债务记录
     * Get user's all liquidation debt records - Get all liquidation debt records for specified user
     * @param user 用户地址 User address
     * @return assets 资产地址数组 Array of asset addresses
     * @return reducedAmounts 已清算债务数量数组 Array of reduced debt amounts
     * @return lastReducedTimes 最后清算时间数组 Array of last reduction times
     */
    function getUserAllLiquidationDebtRecords(
        address user
    ) external view returns (
        address[] memory assets,
        uint256[] memory reducedAmounts,
        uint256[] memory lastReducedTimes
    );

    /**
     * 获取用户总清算债务数量 - 获取指定用户的总清算债务数量
     * Get user's total liquidation debt amount - Get total liquidation debt amount for specified user
     * @param user 用户地址 User address
     * @return totalAmount 总清算债务数量 Total liquidation debt amount
     */
    function getUserTotalLiquidationDebtAmount(address user) external view returns (uint256 totalAmount);

    /**
     * 检查用户是否有清算债务记录 - 检查指定用户是否有清算债务记录
     * Check if user has liquidation debt record - Check if specified user has liquidation debt record
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @return hasRecord 是否有记录 Whether has record
     */
    function hasLiquidationDebtRecord(address user, address asset) external view returns (bool hasRecord);

    /**
     * 获取用户清算债务记录数量 - 获取指定用户的清算债务记录数量
     * Get user's liquidation debt record count - Get liquidation debt record count for specified user
     * @param user 用户地址 User address
     * @return recordCount 记录数量 Record count
     */
    function getUserLiquidationDebtRecordCount(address user) external view returns (uint256 recordCount);

    /* ============ Batch Query Functions ============ */
    
    /**
     * 批量获取用户清算债务记录 - 批量获取多个用户的清算债务记录
     * Batch get liquidation debt records - Batch get liquidation debt records for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @return reducedAmounts 已清算债务数量数组 Array of reduced debt amounts
     * @return lastReducedTimes 最后清算时间数组 Array of last reduction times
     */
    function batchGetLiquidationDebtRecords(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (
        uint256[] memory reducedAmounts,
        uint256[] memory lastReducedTimes
    );
} 