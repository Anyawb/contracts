// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILiquidationRiskManager
/// @notice 清算风险评估管理器接口，负责清算风险评估和阈值管理
/// @dev 从 VaultLendingEngine 拆分出的清算风险评估功能
interface ILiquidationRiskManager {
    /* ============ Events ============ */
    /// @notice 清算阈值更新事件
    /// @param oldThreshold 旧清算阈值
    /// @param newThreshold 新清算阈值
    /// @param timestamp 更新时间戳
    event LiquidationThresholdUpdated(
        uint256 oldThreshold,
        uint256 newThreshold,
        uint256 timestamp
    );

    /// @notice 健康因子缓存更新事件
    /// @param user 用户地址
    /// @param oldHealthFactor 旧健康因子
    /// @param newHealthFactor 新健康因子
    /// @param timestamp 更新时间戳
    event HealthFactorCacheUpdated(
        address indexed user,
        uint256 oldHealthFactor,
        uint256 newHealthFactor,
        uint256 timestamp
    );

    /* ============ Risk Assessment Functions ============ */
    /// @notice 检查用户是否可被清算
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    function isLiquidatable(address user) external view returns (bool liquidatable);

    /// @notice 检查指定抵押物和债务水平是否可被清算
    /// @param user 用户地址
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @param asset 资产地址
    /// @return liquidatable 是否可被清算
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view returns (bool liquidatable);

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return riskScore 风险评分 (0-100)
    function getLiquidationRiskScore(address user) external view returns (uint256 riskScore);

    /// @notice 计算指定抵押物和债务水平的风险评分
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @return riskScore 风险评分 (0-100)
    function calculateLiquidationRiskScore(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256 riskScore);

    /// @notice 获取用户健康因子
    /// @param user 用户地址
    /// @return healthFactor 健康因子（basis points）
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor);

    /// @notice 计算指定抵押物和债务水平的健康因子
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @return healthFactor 健康因子（basis points）
    function calculateHealthFactor(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256 healthFactor);

    /// @notice 获取用户风险评估结果
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    /// @return riskScore 风险评分 (0-100)
    /// @return healthFactor 健康因子（basis points）
    /// @return riskLevel 风险等级 (0-4)
    /// @return safetyMargin 安全边际（basis points）
    function getUserRiskAssessment(address user) external view returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    );

    /* ============ Threshold Management Functions ============ */
    /// @notice 获取清算阈值
    /// @return threshold 清算阈值（basis points）
    function getLiquidationThreshold() external view returns (uint256 threshold);

    /// @notice 更新清算阈值
    /// @param newThreshold 新的清算阈值（basis points）
    function updateLiquidationThreshold(uint256 newThreshold) external;

    /// @notice 获取最小健康因子
    /// @return minHealthFactor 最小健康因子（basis points）
    function getMinHealthFactor() external view returns (uint256 minHealthFactor);

    /// @notice 更新最小健康因子
    /// @param newMinHealthFactor 新的最小健康因子（basis points）
    function updateMinHealthFactor(uint256 newMinHealthFactor) external;

    /* ============ Cache Management Functions ============ */
    /// @notice 更新用户健康因子缓存
    /// @param user 用户地址
    /// @param healthFactor 健康因子
    function updateHealthFactorCache(address user, uint256 healthFactor) external;

    /// @notice 获取用户健康因子缓存
    /// @param user 用户地址
    /// @return healthFactor 缓存的健康因子
    /// @return timestamp 缓存时间戳
    function getHealthFactorCache(address user) external view returns (
        uint256 healthFactor,
        uint256 timestamp
    );

    /// @notice 清除用户健康因子缓存
    /// @param user 用户地址
    function clearHealthFactorCache(address user) external;

    /// @notice 批量更新健康因子缓存
    /// @param users 用户地址数组
    /// @param healthFactors 健康因子数组
    function batchUpdateHealthFactorCache(
        address[] calldata users,
        uint256[] calldata healthFactors
    ) external;

    /* ============ Batch Query Functions ============ */
    /// @notice 批量检查用户是否可被清算
    /// @param users 用户地址数组
    /// @return liquidatableFlags 可清算标志数组
    function batchIsLiquidatable(
        address[] calldata users
    ) external view returns (bool[] memory liquidatableFlags);

    /// @notice 批量获取用户健康因子
    /// @param users 用户地址数组
    /// @return healthFactors 健康因子数组
    function batchGetUserHealthFactors(
        address[] calldata users
    ) external view returns (uint256[] memory healthFactors);

    /// @notice 批量获取用户风险评分
    /// @param users 用户地址数组
    /// @return riskScores 风险评分数组
    function batchGetLiquidationRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores);

    /* ============ Preview Functions moved to View contract ============ */
} 