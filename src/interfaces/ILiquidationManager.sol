// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILiquidationManager
/// @notice 清算编排入口（方案B：直达账本 + View 单点推送）
/// @dev 本接口刻意保持极简：清算只负责“扣押抵押 + 减少债务 + 事件单点推送”，
///      不再承载链上清算记录/统计/奖励子模块写入（这些由链下基于事件聚合）。
interface ILiquidationManager {
    /// @notice 执行单笔清算：CM.withdrawCollateral + LE.forceReduceDebt + LiquidatorView.pushLiquidationUpdate
    /// @param targetUser 被清算用户
    /// @param collateralAsset 抵押资产（被扣押）
    /// @param debtAsset 债务资产（被减记）
    /// @param collateralAmount 扣押数量
    /// @param debtAmount 减债数量
    /// @param bonus 清算奖励（可选透传；如未计算可传 0）
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;

    /// @notice Execute liquidation on behalf of a keeper via SettlementManager, preserving the original liquidator address.
    /// @dev This is used by SettlementManager SSOT to keep `liquidator == keeper msg.sender` semantics.
    ///      Reverts unless called by the registered SettlementManager.
    function liquidateFromSettlementManager(
        address liquidator,
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;

    /// @notice 批量清算：逐条直达账本，最后由 LiquidatorView.pushBatchLiquidationUpdate 单点推送
    function batchLiquidate(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        uint256[] calldata bonuses
    ) external;
} 