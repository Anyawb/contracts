// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILiquidationView
/// @notice 清算查询接口，专门用于view函数查询
/// @dev 提供免费的清算目标监控功能
interface ILiquidationView {
    /* ============ 基础查询函数 ============ */
    
    /// @notice 检查用户是否可被清算
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    function isLiquidatable(address user) external view returns (bool liquidatable);

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return riskScore 风险评分 (0-100)
    function getLiquidationRiskScore(address user) external view returns (uint256 riskScore);

    /// @notice 获取用户健康因子
    /// @param user 用户地址
    /// @return healthFactor 健康因子（basis points）
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor);

    /* ============ 批量查询函数 ============ */
    
    /// @notice 批量检查用户是否可被清算
    /// @param users 用户地址数组
    /// @return liquidatable 是否可被清算数组
    function batchIsLiquidatable(address[] calldata users) external view returns (bool[] memory liquidatable);

    /// @notice 批量获取用户清算风险评分
    /// @param users 用户地址数组
    /// @return riskScores 风险评分数组
    function batchGetLiquidationRiskScores(address[] calldata users) external view returns (uint256[] memory riskScores);

    /// @notice 批量获取用户健康因子
    /// @param users 用户地址数组
    /// @return healthFactors 健康因子数组
    function batchGetUserHealthFactors(address[] calldata users) external view returns (uint256[] memory healthFactors);

    /* ============ 抵押物查询函数 ============ */
    
    /// @notice 获取用户可清算的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可清算数量
    function getSeizableCollateralAmount(address user, address asset) external view returns (uint256 seizableAmount);

    /// @notice 获取用户所有可清算的抵押物
    /// @param user 用户地址
    /// @return assets 资产地址数组
    /// @return amounts 数量数组
    function getSeizableCollaterals(address user) external view returns (address[] memory assets, uint256[] memory amounts);

    /// @notice 计算抵押物价值
    /// @param asset 资产地址
    /// @param amount 数量
    /// @return value 价值
    function calculateCollateralValue(address asset, uint256 amount) external view returns (uint256 value);

    /// @notice 获取用户总抵押物价值
    /// @param user 用户地址
    /// @return totalValue 总价值
    function getUserTotalCollateralValue(address user) external view returns (uint256 totalValue);

    /* ============ 债务查询函数 ============ */
    
    /// @notice 获取用户可清算的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return reducibleAmount 可清算数量
    function getReducibleDebtAmount(address user, address asset) external view returns (uint256 reducibleAmount);

    /// @notice 获取用户所有可清算的债务
    /// @param user 用户地址
    /// @return assets 资产地址数组
    /// @return amounts 数量数组
    function getReducibleDebts(address user) external view returns (address[] memory assets, uint256[] memory amounts);

    /// @notice 计算债务价值
    /// @param asset 资产地址
    /// @param amount 数量
    /// @return value 价值
    function calculateDebtValue(address asset, uint256 amount) external view returns (uint256 value);

    /// @notice 获取用户总债务价值
    /// @param user 用户地址
    /// @return totalValue 总价值
    function getUserTotalDebtValue(address user) external view returns (uint256 totalValue);

    /* ============ 预览函数 ============ */
    
    /// @notice 预览清算效果
    /// @param user 用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 清算抵押物数量
    /// @param debtAmount 清算债务数量
    /// @param simulateFlashLoan 是否模拟Flash Loan影响
    /// @return bonus 清算奖励
    /// @return newHealthFactor 清算后健康因子
    /// @return newRiskScore 清算后风险评分
    /// @return slippageImpact Flash Loan滑点影响
    function previewLiquidation(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        bool simulateFlashLoan
    ) external view returns (
        uint256 bonus,
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 slippageImpact
    );

    /// @notice 批量预览清算效果
    /// @param users 用户地址数组
    /// @param collateralAssets 抵押资产地址数组
    /// @param debtAssets 债务资产地址数组
    /// @param collateralAmounts 清算抵押物数量数组
    /// @param debtAmounts 清算债务数量数组
    /// @param simulateFlashLoan 是否模拟Flash Loan影响数组
    /// @return bonuses 清算奖励数组
    /// @return newHealthFactors 清算后健康因子数组
    /// @return newRiskScores 清算后风险评分数组
    /// @return slippageImpacts Flash Loan滑点影响数组
    function batchPreviewLiquidation(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        bool[] calldata simulateFlashLoan
    ) external view returns (
        uint256[] memory bonuses,
        uint256[] memory newHealthFactors,
        uint256[] memory newRiskScores,
        uint256[] memory slippageImpacts
    );

    /* ============ 风险评估函数 ============ */
    
    /// @notice 获取用户完整的风险评估
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    /// @return riskScore 风险评分
    /// @return healthFactor 健康因子
    /// @return riskLevel 风险等级
    /// @return safetyMargin 安全边际
    function getUserRiskAssessment(address user) external view returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    );

    /// @notice 批量获取用户风险评估
    /// @param users 用户地址数组
    /// @return liquidatable 是否可被清算数组
    /// @return riskScores 风险评分数组
    /// @return healthFactors 健康因子数组
    /// @return riskLevels 风险等级数组
    /// @return safetyMargins 安全边际数组
    function batchGetUserRiskAssessments(address[] calldata users) external view returns (
        bool[] memory liquidatable,
        uint256[] memory riskScores,
        uint256[] memory healthFactors,
        uint256[] memory riskLevels,
        uint256[] memory safetyMargins
    );

    /* ============ 配置查询函数 ============ */
    
    /// @notice 获取清算奖励比例
    /// @return bonusRate 清算奖励比例（basis points）
    function getLiquidationBonusRate() external view returns (uint256 bonusRate);

    /// @notice 获取清算阈值
    /// @return threshold 清算阈值（basis points）
    function getLiquidationThreshold() external view returns (uint256 threshold);

    /// @notice 计算清算奖励
    /// @param amount 清算金额
    /// @return bonus 清算奖励
    function calculateLiquidationBonus(uint256 amount) external view returns (uint256 bonus);
} 