// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationBatchQueryManager
 * @dev 清算批量查询管理器接口 - 负责清算批量查询和优化功能
 * @dev Liquidation Batch Query Manager Interface - Responsible for liquidation batch query and optimization functions
 * @dev 从 ILiquidationDebtManager 拆分出的清算批量查询管理接口
 * @dev Liquidation batch query management interface split from ILiquidationDebtManager
 */
interface ILiquidationBatchQueryManager {
    /* ============ Events ============ */
    
    /**
     * 批量查询完成事件 - 当批量查询完成时触发
     * Batch query completed event - Triggered when batch query is completed
     * @param queryId 查询ID Query ID
     * @param resultCount 结果数量 Result count
     * @param timestamp 时间戳 Timestamp
     */
    event BatchQueryCompleted(
        bytes32 indexed queryId,
        uint256 resultCount,
        uint256 timestamp
    );

    /**
     * 优化清算组合计算完成事件 - 当优化清算组合计算完成时触发
     * Optimal liquidation combination calculated event - Triggered when optimal liquidation combination calculation is completed
     * @param user 用户地址 User address
     * @param optimalDebtReduction 最优债务减少量 Optimal debt reduction
     * @param optimalCollateralReduction 最优抵押物减少量 Optimal collateral reduction
     * @param timestamp 时间戳 Timestamp
     */
    event OptimalLiquidationCalculated(
        address indexed user,
        uint256 optimalDebtReduction,
        uint256 optimalCollateralReduction,
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

    /* ============ Core Batch Query Functions ============ */
    
    /**
     * 批量获取可减少金额 - 批量获取多个用户的可减少金额
     * Batch get reducible amounts - Batch get reducible amounts for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @return reducibleAmounts 可减少金额数组 Array of reducible amounts
     */
    function batchGetReducibleAmounts(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (uint256[] memory reducibleAmounts);

    /**
     * 批量计算债务价值 - 批量计算多个用户的债务价值
     * Batch calculate debt values - Batch calculate debt values for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @return debtValues 债务价值数组 Array of debt values
     */
    function batchCalculateDebtValues(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (uint256[] memory debtValues);

    // 注意：抵押物相关的批量查询功能保留在 LiquidationCollateralManager.sol 中
    // Note: Collateral-related batch query functions remain in LiquidationCollateralManager.sol

    // 注意：清算记录相关的查询功能保留在 LiquidationDebtRecordManager.sol 中
    // Note: Liquidation record query functions remain in LiquidationDebtRecordManager.sol

    /**
     * 计算最优清算组合 - 计算用户的最优清算组合
     * Calculate optimal liquidation combination - Calculate optimal liquidation combination for user
     * @param user 用户地址 User address
     * @param maxDebtReduction 最大债务减少量 Maximum debt reduction
     * @param maxCollateralReduction 最大抵押物减少量 Maximum collateral reduction
     * @return optimalDebtReduction 最优债务减少量 Optimal debt reduction
     * @return optimalCollateralReduction 最优抵押物减少量 Optimal collateral reduction
     * @return healthFactor 健康因子 Health factor
     */
    function calculateOptimalLiquidationCombination(
        address user,
        uint256 maxDebtReduction,
        uint256 maxCollateralReduction
    ) external view returns (
        uint256 optimalDebtReduction,
        uint256 optimalCollateralReduction,
        uint256 healthFactor
    );

    /**
     * 预览清算债务状态 - 预览清算后的债务状态
     * Preview liquidation debt state - Preview debt state after liquidation
     * @param user 用户地址 User address
     * @param debtReduction 债务减少量 Debt reduction
     * @param collateralReduction 抵押物减少量 Collateral reduction
     * @return newHealthFactor 新健康因子 New health factor
     * @return newRiskScore 新风险评分 New risk score
     * @return newRiskLevel 新风险等级 New risk level
     */
    function previewLiquidationDebtState(
        address user,
        uint256 debtReduction,
        uint256 collateralReduction
    ) external view returns (
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 newRiskLevel
    );

    /* ============ Advanced Query Functions ============ */
    
    /**
     * 批量获取用户健康因子 - 批量获取多个用户的健康因子
     * Batch get user health factors - Batch get health factors for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @return healthFactors 健康因子数组 Array of health factors
     */
    function batchGetUserHealthFactors(
        address[] calldata users
    ) external view returns (uint256[] memory healthFactors);

    /**
     * 批量获取用户风险评分 - 批量获取多个用户的风险评分
     * Batch get user risk scores - Batch get risk scores for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @return riskScores 风险评分数组 Array of risk scores
     */
    function batchGetUserRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores);

    /**
     * 获取高风险用户列表 - 获取高风险用户列表
     * Get high risk user list - Get list of high risk users
     * @param riskThreshold 风险阈值 Risk threshold
     * @param limit 限制数量 Limit count
     * @return users 用户地址数组 Array of user addresses
     * @return riskScores 风险评分数组 Array of risk scores
     */
    function getHighRiskUserList(
        uint256 riskThreshold,
        uint256 limit
    ) external view returns (
        address[] memory users,
        uint256[] memory riskScores
    );

    /**
     * 获取可清算用户列表 - 获取可清算用户列表
     * Get liquidatable user list - Get list of liquidatable users
     * @param healthFactorThreshold 健康因子阈值 Health factor threshold
     * @param limit 限制数量 Limit count
     * @return users 用户地址数组 Array of user addresses
     * @return healthFactors 健康因子数组 Array of health factors
     */
    function getLiquidatableUserList(
        uint256 healthFactorThreshold,
        uint256 limit
    ) external view returns (
        address[] memory users,
        uint256[] memory healthFactors
    );

    /* ============ Optimization Functions ============ */
    
    /**
     * 计算最优清算路径 - 计算最优清算路径
     * Calculate optimal liquidation path - Calculate optimal liquidation path
     * @param user 用户地址 User address
     * @param targetHealthFactor 目标健康因子 Target health factor
     * @return liquidationSteps 清算步骤数组 Array of liquidation steps
     * @return totalDebtReduction 总债务减少量 Total debt reduction
     * @return totalCollateralReduction 总抵押物减少量 Total collateral reduction
     */
    function calculateOptimalLiquidationPath(
        address user,
        uint256 targetHealthFactor
    ) external view returns (
        address[] memory liquidationSteps,
        uint256 totalDebtReduction,
        uint256 totalCollateralReduction
    );

    /**
     * 批量优化清算策略 - 批量优化清算策略
     * Batch optimize liquidation strategies - Batch optimize liquidation strategies
     * @param users 用户地址数组 Array of user addresses
     * @param targetHealthFactors 目标健康因子数组 Array of target health factors
     * @return strategies 策略数组 Array of strategies
     */
    function batchOptimizeLiquidationStrategies(
        address[] calldata users,
        uint256[] calldata targetHealthFactors
    ) external view returns (
        bytes[] memory strategies
    );

    /* ============ Registry Management Functions ============ */
    /// @notice 安排模块升级
    /// @param moduleKey 模块键值
    /// @param newAddress 新模块地址
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external;

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external;

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external;

    /// @notice 获取待升级信息
    /// @param moduleKey 模块键值
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view returns (address newAddress, uint256 executeAfter, bool hasPending);

} 