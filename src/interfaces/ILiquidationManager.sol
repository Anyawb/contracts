// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILiquidationManager
/// @notice 清算管理器统一接口，协调清算风险评估、抵押物处理和债务处理
/// @dev 提供清算操作的统一入口，协调各个清算子模块
/// @dev 注意：预览功能和配置管理功能已迁移到专门的模块
/// @dev - previewLiquidation: 迁移到 LiquidationCalculator 和 LiquidationBatchQueryManager
/// @dev - updateLiquidationBonusRate: 迁移到 LiquidationCalculator
/// @dev - getLiquidationThreshold/updateLiquidationThreshold: 迁移到 LiquidationRiskManager
interface ILiquidationManager {
    /* ============ Events ============ */
    /// @notice 清算执行事件
    /// @param liquidator 清算人地址
    /// @param user 被清算用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 清算抵押物数量
    /// @param debtAmount 清算债务数量
    /// @param bonus 清算奖励
    /// @param timestamp 操作时间戳
    event LiquidationExecuted(
        address indexed liquidator,
        address indexed user,
        address indexed collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus,
        uint256 timestamp
    );

    /// @notice 清算奖励更新事件
    /// @param oldBonus 旧清算奖励
    /// @param newBonus 新清算奖励
    /// @param timestamp 更新时间戳
    event LiquidationBonusUpdated(uint256 oldBonus, uint256 newBonus, uint256 timestamp);

    /* ============ Core Liquidation Functions ============ */
    /// @notice 执行清算操作
    /// @param user 被清算用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 清算抵押物数量
    /// @param debtAmount 清算债务数量
    /// @return bonus 清算奖励金额
    /// @dev 协调清算风险评估、抵押物处理和债务处理
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
    function isLiquidatable(address user) external returns (bool liquidatable);

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return riskScore 风险评分 (0-100)
    function getLiquidationRiskScore(address user) external returns (uint256 riskScore);

    /// @notice 获取用户健康因子
    /// @param user 用户地址
    /// @return healthFactor 健康因子（basis points）
    function getUserHealthFactor(address user) external returns (uint256 healthFactor);

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
    ) external view returns (uint256[] memory seizedAmounts);

    /// @notice 转移清算抵押物给清算人
    /// @param asset 资产地址
    /// @param amount 转移数量
    /// @param liquidator 清算人地址
    function transferLiquidationCollateral(
        address asset,
        uint256 amount,
        address liquidator
    ) external;

    /* ============ Debt Management Functions ============ */
    /// @notice 减少用户债务（清算操作）
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

    /// @notice 没收用户保证金（清算时）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param feeReceiver 费用接收者
    /// @return forfeitedAmount 没收数量
    function forfeitGuarantee(
        address user,
        address asset,
        address feeReceiver
    ) external view returns (uint256 forfeitedAmount);

    /* ============ Query Functions ============ */
    /// @notice 获取用户可清算的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可清算数量
    function getSeizableCollateralAmount(address user, address asset) external view returns (uint256 seizableAmount);

    /// @notice 获取用户可清算的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return reducibleAmount 可清算数量
    function getReducibleDebtAmount(address user, address asset) external view returns (uint256 reducibleAmount);

    /// @notice 计算清算奖励
    /// @param amount 清算金额
    /// @return bonus 清算奖励
    function calculateLiquidationBonus(uint256 amount) external view returns (uint256 bonus);

    /// @notice 获取清算奖励比例
    /// @return bonusRate 清算奖励比例（basis points）
    function getLiquidationBonusRate() external view returns (uint256 bonusRate);

    /* ============ 功能迁移说明 ============ */
    /// @dev 以下功能已迁移到专门的模块，不再在此接口中提供：
    /// @dev - previewLiquidation: 迁移到 LiquidationCalculator.previewLiquidationResult()
    /// @dev - updateLiquidationBonusRate: 迁移到 LiquidationCalculator.updateLiquidationBonusRate()
    /// @dev - getLiquidationThreshold: 迁移到 LiquidationRiskManager.getLiquidationThreshold()
    /// @dev - updateLiquidationThreshold: 迁移到 LiquidationRiskManager.updateLiquidationThreshold()
    /// @dev 请使用相应的专门模块接口以获得更好的功能和性能
} 