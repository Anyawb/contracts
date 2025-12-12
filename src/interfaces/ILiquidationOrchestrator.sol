// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILiquidationOrchestrator
/// @notice 清算协调器接口，负责协调清算流程的各个步骤
/// @dev 提供清算操作的协调功能，协调各个清算子模块
interface ILiquidationOrchestrator {
    /* ============ Core Liquidation Functions ============ */
    /// @notice 执行清算操作
    /// @param user 被清算用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 清算抵押物数量
    /// @param debtAmount 清算债务数量
    /// @return bonus 清算奖励金额
    function liquidate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external returns (uint256 bonus);

    /// @notice 批量清算操作
    /// @param users 被清算用户地址数组
    /// @param collateralAssets 抵押资产地址数组
    /// @param debtAssets 债务资产地址数组
    /// @param collateralAmounts 清算抵押物数量数组
    /// @param debtAmounts 清算债务数量数组
    /// @return bonuses 清算奖励金额数组
    function batchLiquidate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts
    ) external returns (uint256[] memory bonuses);

    /* ============ Risk Assessment Functions ============ */
    /// @notice 检查用户是否可被清算
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    function isLiquidatable(address user) external view returns (bool liquidatable);

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return riskScore 风险评分
    function getLiquidationRiskScore(address user) external view returns (uint256 riskScore);

    /// @notice 获取用户健康因子
    /// @param user 用户地址
    /// @return healthFactor 健康因子
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor);

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

    /* ============ Collateral Management Functions ============ */
    /// @notice 扣押用户抵押物
    /// @param user 被清算用户地址
    /// @param asset 抵押资产地址
    /// @param amount 扣押数量
    /// @param liquidator 清算人地址
    /// @return seizedAmount 实际扣押数量
    function seizeCollateral(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external returns (uint256 seizedAmount);

    /// @notice 批量扣押用户抵押物
    /// @param user 被清算用户地址
    /// @param assets 抵押资产地址数组
    /// @param amounts 扣押数量数组
    /// @param liquidator 清算人地址
    /// @return seizedAmounts 实际扣押数量数组
    function batchSeizeCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external returns (uint256[] memory seizedAmounts);

    /// @notice 转移清算抵押物
    /// @param asset 抵押资产地址
    /// @param amount 转移数量
    /// @param liquidator 清算人地址
    function transferLiquidationCollateral(
        address asset,
        uint256 amount,
        address liquidator
    ) external;

    /* ============ Debt Management Functions ============ */
    /// @notice 减少用户债务
    /// @param user 被清算用户地址
    /// @param asset 债务资产地址
    /// @param amount 减少数量
    /// @param liquidator 清算人地址
    /// @return reducedAmount 实际减少数量
    function reduceDebt(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external returns (uint256 reducedAmount);

    /// @notice 批量减少用户债务
    /// @param user 被清算用户地址
    /// @param assets 债务资产地址数组
    /// @param amounts 减少数量数组
    /// @param liquidator 清算人地址
    /// @return reducedAmounts 实际减少数量数组
    function batchReduceDebt(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external returns (uint256[] memory reducedAmounts);

    /// @notice 没收用户保证金
    /// @param user 被清算用户地址
    /// @param asset 资产地址
    /// @param feeReceiver 费用接收者地址
    /// @return forfeitedAmount 没收数量
    function forfeitGuarantee(
        address user,
        address asset,
        address feeReceiver
    ) external returns (uint256 forfeitedAmount);

    /* ============ Query Functions ============ */
    /// @notice 获取可扣押的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可扣押数量
    function getSeizableCollateralAmount(address user, address asset) external view returns (uint256 seizableAmount);

    /// @notice 获取可减少的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return reducibleAmount 可减少数量
    function getReducibleDebtAmount(address user, address asset) external view returns (uint256 reducibleAmount);

    /// @notice 计算清算奖励
    /// @param amount 基础金额
    /// @return bonus 奖励金额
    function calculateLiquidationBonus(uint256 amount) external view returns (uint256 bonus);

    /// @notice 获取清算奖励比例
    /// @return bonusRate 奖励比例
    function getLiquidationBonusRate() external view returns (uint256 bonusRate);

    /* ============ Preview Functions ============ */
    /// @notice 预览清算结果
    /// @param user 用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 抵押物数量
    /// @param debtAmount 债务数量
    /// @param simulateFlashLoan 是否模拟Flash Loan影响
    /// @return bonus 奖励金额
    /// @return newHealthFactor 新的健康因子
    /// @return newRiskScore 新的风险评分
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

    /* ============ Admin Functions ============ */
    /// @notice 更新清算奖励比例
    /// @param newBonusRate 新的奖励比例
    function updateLiquidationBonusRate(uint256 newBonusRate) external;

    /// @notice 获取清算阈值
    /// @return threshold 清算阈值
    function getLiquidationThreshold() external view returns (uint256 threshold);

    /// @notice 更新清算阈值
    /// @param newThreshold 新的清算阈值
    function updateLiquidationThreshold(uint256 newThreshold) external;

    /// @notice 更新平台收入接收者
    /// @param newReceiver 新的接收者地址
    function updatePlatformRevenueReceiver(address newReceiver) external;

    /// @notice 更新风险准备金池
    /// @param newPool 新的池地址
    function updateRiskReservePool(address newPool) external;

    /// @notice 更新出借人补偿池
    /// @param newPool 新的池地址
    function updateLenderCompensationPool(address newPool) external;

    /// @notice 更新清算记录开关
    /// @param newEnabled 新的开关状态
    function updateLiquidationRecordEnabled(bool newEnabled) external;

    /// @notice 紧急暂停
    function emergencyPause() external;

    /// @notice 紧急恢复
    function emergencyUnpause() external;
} 