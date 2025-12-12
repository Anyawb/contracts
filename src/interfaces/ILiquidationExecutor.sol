// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILiquidationExecutor
/// @notice 清算执行接口，专门用于执行清算操作
/// @dev 提供清算执行功能，需要支付gas费用
interface ILiquidationExecutor {
    /* ============ 核心清算函数 ============ */
    
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

    /* ============ 抵押物管理函数 ============ */
    
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

    /// @notice 转移清算抵押物给清算人
    /// @param asset 资产地址
    /// @param amount 转移数量
    /// @param liquidator 清算人地址
    function transferLiquidationCollateral(
        address asset,
        uint256 amount,
        address liquidator
    ) external;

    /* ============ 债务管理函数 ============ */
    
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
    ) external returns (uint256 forfeitedAmount);

    /* ============ 缓存管理函数 ============ */
    
    /// @notice 更新用户健康因子缓存
    /// @param user 用户地址
    function updateHealthFactorCache(address user) external;

    /// @notice 批量更新用户健康因子缓存
    /// @param users 用户地址数组
    function batchUpdateHealthFactorCache(address[] calldata users) external;

    /// @notice 清除用户健康因子缓存
    /// @param user 用户地址
    function clearHealthFactorCache(address user) external;

    /// @notice 批量清除用户健康因子缓存
    /// @param users 用户地址数组
    function batchClearHealthFactorCache(address[] calldata users) external;

    /* ============ 管理函数 ============ */
    
    /// @notice 更新清算奖励比例
    /// @param newBonusRate 新的清算奖励比例（basis points）
    function updateLiquidationBonusRate(uint256 newBonusRate) external;

    /// @notice 更新清算阈值
    /// @param newThreshold 新的清算阈值（basis points）
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