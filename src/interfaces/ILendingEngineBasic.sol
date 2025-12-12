// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILendingEngineBasic 多资产债务管理基础接口
/// @notice 提供多资产债务记录、查询和管理的统一入口
/// @dev 支持多种结算币的债务管理，每种资产独立记账
interface ILendingEngineBasic {
    /**
     * @notice 记录用户指定资产的借款
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 借款金额
     * @param collateralAdded 本次伴随的新增抵押物价值（占位参数）
     * @param termDays 借款期限（天，预留参数）
     */
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external;

    /**
     * @notice 记录用户指定资产的还款
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 还款金额
     */
    function repay(address user, address asset, uint256 amount) external;

    /**
     * @notice 查询用户指定资产的当前债务
     * @param user 用户地址
     * @param asset 债务资产地址
     * @return debt 当前债务金额
     */
    function getDebt(address user, address asset) external view returns (uint256 debt);

    /**
     * @notice 查询指定资产的总债务
     * @param asset 债务资产地址
     * @return totalDebt 总债务金额
     */
    function getTotalDebtByAsset(address asset) external view returns (uint256 totalDebt);

    /**
     * @notice 查询用户总债务价值（以结算币计价）
     * @param user 用户地址
     * @return totalValue 用户总债务价值
     */
    function getUserTotalDebtValue(address user) external view returns (uint256 totalValue);

    /**
     * @notice 查询系统总债务价值（以结算币计价）
     * @return totalValue 系统总债务价值
     */
    function getTotalDebtValue() external view returns (uint256 totalValue);

    /**
     * @notice 查询用户所有债务资产列表
     * @param user 用户地址
     * @return assets 用户债务的资产地址数组
     */
    function getUserDebtAssets(address user) external view returns (address[] memory assets);

    /**
     * @notice 强制减少用户指定资产的债务（清算场景）
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 减少的债务金额
     */
    function forceReduceDebt(address user, address asset, uint256 amount) external;

    /**
     * @notice 计算用户借款一定数量资产时应该产生的利息
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 借款金额
     * @return interest 预估利息金额
     */
    function calculateExpectedInterest(address user, address asset, uint256 amount) external view returns (uint256 interest);

    /* ============ Liquidation Related Functions ============ */
    
    /**
     * @notice 获取用户可清算的债务数量
     * @param user 用户地址
     * @param asset 债务资产地址
     * @return reducibleAmount 可清算数量
     */
    function getReducibleDebtAmount(address user, address asset) external view returns (uint256 reducibleAmount);

    /**
     * @notice 计算债务价值（以结算币计价）
     * @param user 用户地址
     * @param asset 债务资产地址
     * @return value 债务价值
     */
    function calculateDebtValue(address user, address asset) external view returns (uint256 value);

    /**
     * @notice 计算最优清算组合
     * @param user 用户地址
     * @param maxDebtReduction 最大债务减少量
     * @param maxCollateralReduction 最大抵押物减少量
     * @return debtReduction 最优债务减少量
     * @return collateralReduction 最优抵押物减少量
     * @return healthFactor 健康因子
     */
    function calculateOptimalLiquidation(
        address user,
        uint256 maxDebtReduction,
        uint256 maxCollateralReduction
    ) external view returns (
        uint256 debtReduction,
        uint256 collateralReduction,
        uint256 healthFactor
    );

    /**
     * @notice 预览清算状态
     * @param user 用户地址
     * @param debtReduction 债务减少量
     * @param collateralReduction 抵押物减少量
     * @return newHealthFactor 新健康因子
     * @return newRiskScore 新风险评分
     * @return newRiskLevel 新风险等级
     */
    function previewLiquidationState(
        address user,
        uint256 debtReduction,
        uint256 collateralReduction
    ) external view returns (
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 newRiskLevel
    );

    /**
     * @notice 获取用户健康因子
     * @param user 用户地址
     * @return healthFactor 健康因子
     */
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor);

    /**
     * @notice 获取用户风险评分
     * @param user 用户地址
     * @return riskScore 风险评分
     */
    function getUserRiskScore(address user) external view returns (uint256 riskScore);

    /**
     * @notice 获取高风险用户列表
     * @param riskThreshold 风险阈值
     * @param limit 限制数量
     * @return users 用户地址数组
     * @return riskScores 风险评分数组
     */
    function getHighRiskUsers(
        uint256 riskThreshold,
        uint256 limit
    ) external view returns (
        address[] memory users,
        uint256[] memory riskScores
    );

    /**
     * @notice 获取可清算用户列表
     * @param healthFactorThreshold 健康因子阈值
     * @param limit 限制数量
     * @return users 用户地址数组
     * @return healthFactors 健康因子数组
     */
    function getLiquidatableUsers(
        uint256 healthFactorThreshold,
        uint256 limit
    ) external view returns (
        address[] memory users,
        uint256[] memory healthFactors
    );

    /**
     * @notice 计算最优清算路径
     * @param user 用户地址
     * @param targetHealthFactor 目标健康因子
     * @return liquidationSteps 清算步骤数组
     * @return totalDebtReduction 总债务减少量
     * @return totalCollateralReduction 总抵押物减少量
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
     * @notice 优化清算策略
     * @param user 用户地址
     * @param targetHealthFactor 目标健康因子
     * @return strategy 优化策略
     */
    function optimizeLiquidationStrategy(
        address user,
        uint256 targetHealthFactor
    ) external view returns (bytes memory strategy);
} 