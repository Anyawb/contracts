// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationDebtManager
 * @dev 清算债务管理器接口 - 负责清算时的债务处理
 * @dev Liquidation Debt Manager Interface - Responsible for debt handling during liquidation
 * @dev 从 VaultLendingEngine 拆分出的清算债务处理功能
 * @dev Debt handling functions split from VaultLendingEngine for liquidation
 * @dev 积分奖励功能已移至 ILiquidationRewardManager
 * @dev Reward functions have been moved to ILiquidationRewardManager
 */
interface ILiquidationDebtManager {
    /* ============ Events ============ */
    
    /**
     * 清算债务减少事件 - 当债务被清算减少时触发
     * Liquidation debt reduced event - Triggered when debt is reduced during liquidation
     * @param liquidator 清算人地址 Liquidator address
     * @param user 被清算用户地址 User address being liquidated
     * @param asset 债务资产地址 Debt asset address
     * @param amount 减少数量 Reduced amount
     * @param timestamp 操作时间戳 Operation timestamp
     */
    event LiquidationDebtReduced(
        address indexed liquidator,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );

    /**
     * 清算债务记录更新事件 - 当清算债务记录更新时触发
     * Liquidation debt record updated event - Triggered when liquidation debt record is updated
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param oldAmount 旧债务数量 Old debt amount
     * @param newAmount 新债务数量 New debt amount
     * @param timestamp 更新时间戳 Update timestamp
     */
    event LiquidationDebtRecordUpdated(
        address indexed user,
        address indexed asset,
        uint256 oldAmount,
        uint256 newAmount,
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

    /* ============ Core Liquidation Functions ============ */
    
    /**
     * 减少用户债务 - 减少指定用户的债务（清算操作）
     * Reduce user debt - Reduce specified user's debt (liquidation operation)
     * @param user 被清算用户地址 User address being liquidated
     * @param asset 债务资产地址 Debt asset address
     * @param amount 减少数量 Amount to reduce
     * @param liquidator 清算人地址 Liquidator address
     * @return reducedAmount 实际减少数量 Actual reduced amount
     */
    function reduceDebt(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external returns (uint256 reducedAmount);

    /**
     * 批量减少用户债务 - 批量减少指定用户的多种债务
     * Batch reduce user debt - Batch reduce multiple debts of specified user
     * @param user 被清算用户地址 User address being liquidated
     * @param assets 债务资产地址数组 Array of debt asset addresses
     * @param amounts 减少数量数组 Array of amounts to reduce
     * @param liquidator 清算人地址 Liquidator address
     * @return reducedAmounts 实际减少数量数组 Array of actual reduced amounts
     */
    function batchReduceDebt(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external returns (uint256[] memory reducedAmounts);

    /**
     * 批量减少债务 - 批量减少用户债务
     * Batch reduce debt - Batch reduce user debt
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @param amounts 减少数量数组 Array of reduced amounts
     * @param liquidator 清算人地址 Liquidator address
     */
    function batchReduceUserDebt(
        address[] calldata users,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external;

    /* ============ Query Functions ============ */
    
    /**
     * 获取用户清算债务记录 - 获取用户清算债务记录
     * Get liquidation debt record - Get user liquidation debt record
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
     * 获取用户总清算债务数量 - 获取用户总清算债务数量
     * Get user total liquidation debt amount - Get user total liquidation debt amount
     * @param user 用户地址 User address
     * @return totalAmount 总清算债务数量 Total liquidation debt amount
     */
    function getUserTotalLiquidationDebtAmount(address user) external view returns (uint256 totalAmount);

    /**
     * 获取清算人临时债务数量 - 获取清算人临时债务数量
     * Get liquidator temp debt - Get liquidator temporary debt amount
     * @param liquidator 清算人地址 Liquidator address
     * @param asset 资产地址 Asset address
     * @return tempDebtAmount 临时债务数量 Temporary debt amount
     */
    function getLiquidatorTempDebt(address liquidator, address asset) external view returns (uint256 tempDebtAmount);

    /* ============ Admin Functions ============ */
    
    /**
     * 更新价格预言机地址 - 更新价格预言机地址
     * Update price oracle address - Update price oracle address
     * @param newPriceOracle 新的价格预言机地址 New price oracle address
     */
    function updatePriceOracle(address newPriceOracle) external;

    /**
     * 更新结算币地址 - 更新结算币地址
     * Update settlement token address - Update settlement token address
     * @param newSettlementToken 新的结算币地址 New settlement token address
     */
    function updateSettlementToken(address newSettlementToken) external;

    /**
     * 获取价格预言机地址 - 获取价格预言机地址
     * Get price oracle address - Get price oracle address
     * @return priceOracle 价格预言机地址 Price oracle address
     */
    function getPriceOracle() external view returns (address priceOracle);

    /**
     * 获取结算币地址 - 获取结算币地址
     * Get settlement token address - Get settlement token address
     * @return settlementToken 结算币地址 Settlement token address
     */
    function getSettlementToken() external view returns (address settlementToken);
} 