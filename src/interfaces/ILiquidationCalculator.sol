// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationCalculator
 * @dev 清算计算器接口 - 负责清算相关的所有计算和预览功能
 * @dev Liquidation Calculator Interface - Responsible for all liquidation-related calculations and preview functions
 * @dev 提供清算奖励计算、预览清算结果、资产价值计算等功能
 * @dev Provides liquidation bonus calculation, liquidation result preview, asset value calculation and other functions
 */
interface ILiquidationCalculator {
    /* ============ Calculation Functions ============ */
    
    /**
     * 计算清算奖励 - 计算指定金额的清算奖励
     * Calculate liquidation bonus - Calculate liquidation bonus for specified amount
     * @param amount 基础金额 Base amount
     * @return bonus 奖励金额 Bonus amount
     */
    function calculateLiquidationBonus(uint256 amount) external view returns (uint256 bonus);

    /**
     * 获取清算奖励比例 - 返回当前的清算奖励比例
     * Get liquidation bonus rate - Return current liquidation bonus rate
     * @return bonusRate 奖励比例 Bonus rate
     */
    function getLiquidationBonusRate() external view returns (uint256 bonusRate);

    /**
     * 获取清算阈值 - 返回当前的清算阈值
     * Get liquidation threshold - Return current liquidation threshold
     * @return threshold 清算阈值 Liquidation threshold
     */
    function getLiquidationThreshold() external view returns (uint256 threshold);

    /* ============ Preview Functions ============ */
    
    /**
     * 预览清算结果 - 预览清算操作的结果
     * Preview liquidation result - Preview the result of liquidation operation
     * @param user 用户地址 User address
     * @param collateralAsset 抵押资产地址 Collateral asset address
     * @param debtAsset 债务资产地址 Debt asset address
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @return bonus 奖励金额 Bonus amount
     * @return newHealthFactor 新的健康因子 New health factor
     * @return newRiskScore 新的风险评分 New risk score
     */
    function previewLiquidation(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (
        uint256 bonus,
        uint256 newHealthFactor,
        uint256 newRiskScore
    );

    /* ============ Asset Value Functions ============ */
    
    /**
     * 获取资产价值 - 获取抵押资产和债务资产的价值
     * Get asset values - Get values of collateral asset and debt asset
     * @param collateralAsset 抵押资产地址 Collateral asset address
     * @param debtAsset 债务资产地址 Debt asset address
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @return collateralValue 抵押物价值 Collateral value
     * @return debtValue 债务价值 Debt value
     */
    function getAssetValues(
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (uint256 collateralValue, uint256 debtValue);

    /* ============ Optimization Functions ============ */
    
    /**
     * 计算最优清算组合 - 计算最优的清算组合
     * Calculate optimal liquidation combination - Calculate optimal liquidation combination
     * @param user 用户地址 User address
     * @param targetValue 目标价值 Target value
     * @return assets 资产地址数组 Array of asset addresses
     * @return amounts 数量数组 Array of amounts
     * @return totalValue 总价值 Total value
     */
    function calculateOptimalLiquidationCombination(
        address user,
        uint256 targetValue
    ) external view returns (
        address[] memory assets,
        uint256[] memory amounts,
        uint256 totalValue
    );

    /* ============ Preview Functions ============ */
    
    /**
     * 预览清算债务状态 - 预览清算债务状态
     * Preview liquidation debt state - Preview liquidation debt state
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param reduceAmount 减少数量 Amount to reduce
     * @return newDebtAmount 新的债务数量 New debt amount
     * @return newTotalValue 新的总价值 New total value
     */
    function previewLiquidationDebtState(
        address user,
        address asset,
        uint256 reduceAmount
    ) external view returns (uint256 newDebtAmount, uint256 newTotalValue);

    /* ============ Admin Functions ============ */
    
    /**
     * 更新清算奖励比例 - 更新清算奖励比例
     * Update liquidation bonus rate - Update liquidation bonus rate
     * @param newBonusRate 新的奖励比例 New bonus rate
     */
    function updateLiquidationBonusRate(uint256 newBonusRate) external;

    /**
     * 更新清算阈值 - 更新清算阈值
     * Update liquidation threshold - Update liquidation threshold
     * @param newThreshold 新的清算阈值 New liquidation threshold
     */
    function updateLiquidationThreshold(uint256 newThreshold) external;

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
} 